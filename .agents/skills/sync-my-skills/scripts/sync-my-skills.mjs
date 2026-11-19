#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SyncError, loadCatalog, refreshCatalog, inspectProject, prepareSkills, reviewSkill, planSync,
  applySync, projectStatus, planSetup, applySetup, INSTRUCTION_FILES, reviewInstructions, OWNER_CATALOG_PATH,
} from "./sync-core.mjs";

const HELP = `sync-my-skills. Approved project skills and instruction bundles

Commands:
  catalog [--source-root REPO] [--catalog YAML]
  refresh [--catalog YAML]
  inspect --root PROJECT [--bundled | --source-root REPO | --catalog YAML]
  prepare --root PROJECT [--skills a,b] --stage NEW_DIR [--source-root REPO]
          [--catalog YAML] [--fetch] [--target-requirements TEXT]
          [--instructions [--claude-import]]
  review --stage DIR --name SKILL --note TEXT
  review-instructions --stage DIR --note TEXT [--evidence JSON]
  plan --root PROJECT --stage DIR --selection JSON [--catalog YAML]
  apply --root WORKTREE --stage DIR --selection JSON [--catalog YAML]
        --apply --confirm --plan-id ID
  status --root PROJECT
  setup --harnesses pi,opencode,claude-code [--home DIR] [--manager-root DIR]
        [--apply --confirm --plan-id ID]

Inspect refreshes and pins the curated YAML in external temporary storage by default.
--bundled explicitly uses the installed snapshot; --source-root uses that checkout.
Carry inspect's catalogSnapshot.path to prepare/plan/apply with --catalog.
Manager code is never automatically updated. Unsupported catalogs stop.
Plan/inspect never mutate the target. Preparation and review write only their
external stage. Apply requires an isolated Git worktree and a matching plan.
Setup is a separate personal-configuration plan; it does not install packages.
Instruction changes require the complete bundle, its guidance, output review,
explicit policy approval, and a selected plan. Skills CLI-owned locks are untouched.
`;
const FLAGS = new Set(["apply", "confirm", "fetch", "help", "bundled", "instructions", "claude-import"]);
const VALUES = new Set(["root", "stage", "skills", "source-root", "catalog", "selection", "name", "note", "plan-id", "harnesses", "home", "manager-root", "target-requirements", "evidence"]);
function argumentsFor(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) throw new SyncError("Use named options", 2);
    const key = args[i].slice(2);
    if (Object.hasOwn(options, key)) throw new SyncError(`Duplicate option: ${key}`, 2);
    if (FLAGS.has(key)) options[key] = true;
    else if (VALUES.has(key) && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) options[key] = args[++i];
    else throw new SyncError(`Unknown option or missing value: ${key}`, 2);
  }
  return { command, options };
}
function need(options, ...keys) {
  for (const key of keys) if (!options[key]) throw new SyncError(`--${key} is required`, 2);
}
function selection(path, label = "selection") {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new SyncError(`Cannot read ${label} JSON`, 2); }
}
async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 20)) throw new SyncError("Node.js 22.20 or newer is required", 4);
  if (!process.argv[2] || process.argv.includes("--help")) { console.log(HELP); return; }
  const { command, options: o } = argumentsFor(process.argv.slice(2));
  const common = { root: o.root, stage: o.stage, planId: o["plan-id"], apply: o.apply, confirm: o.confirm };
  let result;
  if (command === "status") { need(o, "root"); result = projectStatus(o.root); }
  else if (command === "review") { need(o, "stage", "name", "note"); result = reviewSkill({ ...common, name: o.name, note: o.note }); }
  else if (command === "review-instructions") { need(o, "stage", "note"); result = reviewInstructions({ ...common, note: o.note, evidence: o.evidence ? selection(o.evidence, "evidence") : [] }); }
  else if (command === "setup") {
    need(o, "harnesses");
    const input = { ...common, home: o.home, managerRoot: o["manager-root"], harnesses: o.harnesses.split(",") };
    result = o.apply ? applySetup(input) : planSetup(input);
  } else {
    if (!["catalog", "refresh", "inspect", "prepare", "plan", "apply"].includes(command)) throw new SyncError("Unknown command; use --help", 2);
    if (!["catalog", "refresh"].includes(command)) need(o, "root");
    if (o.bundled && (command === "refresh" || o.catalog || o["source-root"])) throw new SyncError("--bundled cannot be combined with refresh, --catalog, or --source-root", 2);
    const localPath = o.catalog ?? (o["source-root"] ? join(resolve(o["source-root"]), OWNER_CATALOG_PATH) : undefined);
    let catalog = loadCatalog(localPath, o["source-root"]);
    let snapshotMode = o.catalog ? "explicit" : o["source-root"] ? "local-source" : "bundled";
    if (command === "refresh" || (command === "inspect" && !o.bundled && !o.catalog && !o["source-root"])) {
      try {
        const snapshot = await refreshCatalog({ catalog, root: o.root });
        catalog = loadCatalog(snapshot.path);
        snapshotMode = "refreshed";
      } catch (error) {
        throw new SyncError(`Catalog refresh stopped: ${error.message}. Manager code was not updated. Resolve the source/version or explicitly choose --bundled; no automatic fallback is used.`, error instanceof SyncError ? error.exitCode : 5);
      }
    }
    if (command === "catalog") result = { schemaVersion: 2, catalogHash: catalog.hash, skills: catalog.skills, deprecations: catalog.deprecations ?? {}, instructionTemplates: catalog.instructionTemplates ?? null };
    else if (command === "refresh") result = { mode: "catalog-refreshed", path: catalog.path, hash: catalog.hash, source: catalog.catalogSource };
    else if (command === "inspect") result = { ...inspectProject({ ...common, catalog }), catalogSnapshot: { mode: snapshotMode, path: catalog.path, hash: catalog.hash, source: catalog.catalogSource } };
    else if (command === "prepare") {
      need(o, "root", "stage");
      if (o["claude-import"] && !o.instructions) throw new SyncError("--claude-import requires --instructions", 2);
      const instructionFiles = o.instructions ? [...INSTRUCTION_FILES.slice(0, 4), ...(o["claude-import"] ? ["CLAUDE.md"] : [])] : [];
      result = await prepareSkills({ ...common, catalog, names: o.skills ? o.skills.split(",") : [], sourceRoot: o["source-root"], allowFetch: o.fetch, targetRequirements: o["target-requirements"] ?? "", instructionFiles });
    } else {
      need(o, "root", "stage", "selection");
      const input = { ...common, catalog, selection: selection(o.selection) };
      result = command === "apply" ? applySync(input) : planSync(input);
    }
  }
  console.log(JSON.stringify({ skill: "sync-my-skills", command, ...result }, null, 2));
}
main().catch((error) => {
  console.error(error instanceof SyncError ? error.message : `Synchronization failed: ${error.message}`);
  process.exitCode = error instanceof SyncError ? error.exitCode : 6;
});
