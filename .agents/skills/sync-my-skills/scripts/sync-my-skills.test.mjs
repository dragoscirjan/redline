import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as sync from "./sync-core.mjs";
import { stringify } from "yaml";
import {
  PACKAGE_ROOT, OWNER_CATALOG_PATH, LOCK_PATH, digest, parseYaml, safeRelative, loadCatalog, refreshCatalog, closure,
  inspectProject, prepareSkills, reviewSkill, planSync, applySync, projectStatus,
  planSetup, applySetup,
} from "./sync-core.mjs";

const script = join(PACKAGE_ROOT, "scripts/sync-my-skills.mjs");
const repository = resolve(PACKAGE_ROOT, "../../../..");
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function put(root, path, text) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
function init(root) {
  mkdirSync(root, { recursive: true }); git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "user.name", "Sync Fixture"); git(root, "config", "user.email", "sync@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
}
function commit(root) { git(root, "add", "."); return git(root, "commit", "-qm", "Fixture"); }
function skill(name, text = "Keep the useful workflow.", requirements = []) {
  return `---\nname: ${name}\ndescription: Fixture ${name}.\n${requirements.length ? `requires: ${JSON.stringify(requirements)}\n` : ""}---\n\n${text}\n`;
}
function fixture(t, change = () => {}) {
  const base = mkdtempSync(join(tmpdir(), "sync-my-skills-test-"));
  // Only this test's disposable repositories are removed. Never touch real workspaces.
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, "source"); const primary = join(base, "project"); const root = join(base, "worktree");
  init(source); init(primary);
  git(source, "remote", "add", "origin", "https://github.com/example/skills");
  put(source, "LICENSE", "MIT License\nCopyright Fixture\n");
  for (const name of ["alpha", "beta"]) put(source, `.agents/skills/${name}/SKILL.md`, skill(name));
  put(source, ".agents/skills/alpha/reference.md", "Supporting reference.\n");
  const definition = (name) => ({
    kind: "authored", description: `Fixture ${name}.`, source: { type: "local", path: `.agents/skills/${name}` },
    harnesses: ["pi", "opencode", "claude-code"], prerequisites: [], selection: "optional",
    install: { argv: ["npx", "-y", "skills@1.7.4", "add", "example/skills", "--skill", name] },
    legal: [{ path: "LICENSE", target: "LICENSE", spdx: "MIT" }],
  });
  const data = { schemaVersion: 2, repository: "https://github.com/example/skills", ref: "main", defaults: { exclude: ["agents/openai.yaml"] }, skills: { alpha: definition("alpha"), beta: definition("beta") }, deprecations: { "coding-ts": { replacements: ["alpha"], reason: "Explicit legacy mapping." } }, instructionTemplates: { enabled: false, issue: 68 } };
  put(primary, "README.md", "# Documentation collection\nNo application runtime.\n");
  put(primary, "AGENTS.md", "Respect existing project authority.\n");
  put(primary, "CONTRIBUTING.md", "Project-specific contributions.\n");
  put(primary, "VALIDATION.md", "Project-specific checks.\n");
  put(primary, "CLAUDE.md", "Existing Claude instructions.\n");
  change({ source, primary, data, base });
  const catalogPath = join(source, "catalog.yaml"); put(source, "catalog.yaml", stringify(data));
  commit(source); commit(primary);
  git(primary, "worktree", "add", "-q", "-b", "change/fixture", root, "HEAD");
  const catalog = loadCatalog(catalogPath, source);
  const stage = join(base, "stage");
  function selection(names = ["alpha"], extra = {}) {
    const selected = closure(names, catalog);
    return { selectedSkills: names, declinedSkills: catalog.skills.filter((s) => s.scope === "project" && !selected.includes(s.name)).map((s) => ({ name: s.name, reason: "User chose not to install now." })), harnesses: ["pi"], removeSkills: [], ...extra };
  }
  async function prepare(names = ["alpha"], extra = {}) { return prepareSkills({ catalog, names, stage, sourceRoot: source, root, ...extra }); }
  function plan(input = selection(), extra = {}) { return planSync({ root, stage, catalog, selection: input, ...extra }); }
  function apply(input = selection(), extra = {}) { const p = plan(input, extra); return applySync({ root, stage, catalog, selection: input, apply: true, confirm: true, planId: p.planId, ...extra }); }
  return { base, source, primary, root, stage, data, catalog, catalogPath, selection, prepare, plan, apply };
}

test("strict YAML rejects duplicates, aliases, tags, multiple documents and unsafe keys", () => {
  for (const text of ["a: 1\na: 2", "a: &x [1]\nb: *x", "a: !unknown text", "---\na: 1\n---\nb: 2", "__proto__: x", "a:\n  constructor: x"]) {
    assert.throws(() => parseYaml(text));
  }
  assert.equal(parseYaml("instructions: |\n  Preserve behavior.\n  Explain changes.\n").instructions, "Preserve behavior.\nExplain changes.\n");
});

test("static Git inspection never executes a repository fsmonitor hook", (t) => {
  const f = fixture(t);
  const marker = join(f.base, "hook-ran");
  const hook = join(f.primary, ".git/hooks/fsmonitor-fixture");
  writeFileSync(hook, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.SYNC_TEST_MARKER, 'ran');\nprocess.stdout.write('token\\0');\n`);
  chmodSync(hook, 0o755);
  const old = process.env.SYNC_TEST_MARKER;
  process.env.SYNC_TEST_MARKER = marker;
  t.after(() => { if (old === undefined) delete process.env.SYNC_TEST_MARKER; else process.env.SYNC_TEST_MARKER = old; });
  git(f.primary, "config", "core.fsmonitor", hook);
  inspectProject({ root: f.root, catalog: f.catalog });
  assert.equal(existsSync(marker), false);
});

test("paths reject traversal, absolute paths, backslashes and ambiguous segments", () => {
  for (const path of ["../x", "/tmp/x", "x/../y", "x//y", "x/./y", "x\\y", "C:/x", "x\ny"]) assert.throws(() => safeRelative(path));
  assert.equal(safeRelative("references/test.md"), "references/test.md");
});

function categorizeSource({ source, data }) {
  for (const [name, category] of [["alpha", "coding"], ["beta", "productivity"]]) {
    const path = `.agents/skills/${category}/${name}`;
    mkdirSync(dirname(join(source, path)), { recursive: true });
    fs.renameSync(join(source, data.skills[name].source.path), join(source, path));
    data.skills[name].source.path = path;
  }
}

test("categorized sources install flat for every harness with supporting files and provenance", async (t) => {
  const f = fixture(t, categorizeSource);
  const before = git(f.source, "status", "--porcelain");
  await f.prepare(["alpha", "beta"]);
  f.apply(f.selection(["alpha", "beta"], { harnesses: ["pi", "opencode", "claude-code"] }));
  for (const name of ["alpha", "beta"]) {
    assert.ok(existsSync(join(f.root, `.agents/skills/${name}/SKILL.md`)));
    assert.equal(readlinkSync(join(f.root, `.claude/skills/${name}`)), `../../.agents/skills/${name}`);
    assert.match(readFileSync(join(f.root, `.agents/skills/${name}/LICENSE`), "utf8"), /MIT License/);
  }
  assert.equal(readFileSync(join(f.root, ".agents/skills/alpha/reference.md"), "utf8"), "Supporting reference.\n");
  for (const category of ["coding", "productivity"]) assert.equal(existsSync(join(f.root, ".agents/skills", category)), false);
  const lock = JSON.parse(readFileSync(join(f.root, LOCK_PATH), "utf8"));
  assert.equal(lock.skills.alpha.origin.path, ".agents/skills/coding/alpha");
  assert.equal(git(f.source, "status", "--porcelain"), before);
  assert.ok(projectStatus(f.root).files.every((file) => file.state === "clean"));
});

test("recursive source coverage rejects uncatalogued skills and duplicate names across categories", (t) => {
  const f = fixture(t, categorizeSource);
  const rogue = ".agents/skills/utility/rogue";
  put(f.source, `${rogue}/SKILL.md`, skill("rogue"));
  assert.throws(() => loadCatalog(f.catalogPath, f.source), /coverage/);
  rmSync(join(f.source, rogue), { recursive: true });
  put(f.source, ".agents/skills/productivity/alpha/SKILL.md", skill("alpha"));
  assert.throws(() => loadCatalog(f.catalogPath, f.source), /Duplicate local skill name: alpha/);
});

test("recursive source coverage rejects linked categories and mismatched source locations", (t) => {
  const f = fixture(t, categorizeSource);
  const alias = join(f.source, ".agents/skills/linked");
  symlinkSync("coding", alias);
  assert.throws(() => loadCatalog(f.catalogPath, f.source), /Symlink/);
  rmSync(alias);
  const outside = ".agents/other/alpha";
  mkdirSync(dirname(join(f.source, outside)), { recursive: true });
  fs.renameSync(join(f.source, f.data.skills.alpha.source.path), join(f.source, outside));
  f.data.skills.alpha.source.path = outside;
  put(f.source, "catalog.yaml", stringify(f.data));
  assert.throws(() => loadCatalog(f.catalogPath, f.source), /coverage/);
});

test("catalog rejects unknown sources, cycles, invalid commands and missing local declarations", (t) => {
  const f = fixture(t);
  const check = (change) => {
    const data = structuredClone(f.data); change(data); put(f.source, "invalid.yaml", stringify(data));
    assert.throws(() => loadCatalog(join(f.source, "invalid.yaml"), f.source));
  };
  check((d) => { d.skills.alpha.install.argv.splice(1, 1); });
  check((d) => { d.skills.alpha.install.argv = ["bash", "-c", "anything"]; });
  check((d) => { d.skills.alpha.install.argv.push("--global"); });
  check((d) => { d.skills.alpha.install.argv.push("--global=true"); });
  check((d) => { d.skills.alpha.prerequisites = ["missing"]; });
  check((d) => { d.skills.alpha.prerequisites = ["beta"]; d.skills.beta.prerequisites = ["alpha"]; });
  check((d) => { d.skills.alpha.source.path = "../outside"; });
  check((d) => { d.skills.alpha.unknown = true; });
  check((d) => { d.skills.alpha.selection = "silently-install"; });
  check((d) => { d.skills.alpha.signals = { files: "package.json" }; });
  check((d) => { d.skills.alpha.install.argv.push("/private/machine/path"); });
  check((d) => { d.deprecations = []; });
  check((d) => { d.instructionTemplates.enabled = true; });
  check((d) => { d.skills.alpha.source = { type: "github", repository: "https://user:token@github.com/example/skills", revision: "a".repeat(40), path: "alpha" }; });
  check((d) => { d.skills.alpha.source = { type: "github", repository: "https://github.com/example/skills", revision: "main", path: "alpha" }; });
  put(f.source, ".agents/skills/alpha/SKILL.md", skill("alpha", "Body", ["beta"]));
  assert.throws(() => loadCatalog(f.catalogPath, f.source), /declared prerequisite/);
});

test("installation argv may repeat flags without becoming a shell command", (t) => {
  const f = fixture(t, ({ data }) => { data.skills.alpha.install.argv.push("--agent", "pi", "--agent", "opencode"); });
  assert.equal(f.catalog.byName.get("alpha").install.argv.filter((v) => v === "--agent").length, 2);
});

test("non-coding inspection offers every remaining skill and does not force coding policy", (t) => {
  const f = fixture(t, ({ source, primary, data }) => {
    put(source, ".agents/skills/alpha/scripts/tool.mjs", "// Managed helper, not target application evidence.\n");
    put(primary, ".github/scripts/release.py", "# CI support is not the primary project purpose.\n");
    data.skills.alpha.selection = "detected"; data.skills.alpha.signals = { extensions: [".mjs", ".py"] };
  });
  const before = git(f.root, "status", "--porcelain");
  const result = inspectProject({ root: f.root, catalog: f.catalog });
  assert.deepEqual(result.recommendedSkills, []);
  assert.deepEqual(result.remainingSkills.map((s) => s.name), ["alpha", "beta"]);
  assert.deepEqual(result.detectedHarnesses, []);
  assert.equal(git(f.root, "status", "--porcelain"), before);
  assert.equal(existsSync(join(f.root, LOCK_PATH)), false);
});

test("read-only inspection never executes a configured Git clean filter", (t) => {
  const f = fixture(t); const marker = join(f.base, "filter-ran"); const scriptPath = join(f.root, "filter.mjs");
  put(f.root, ".gitattributes", "target.txt filter=probe\n"); put(f.root, "target.txt", "before\n");
  writeFileSync(scriptPath, "import fs from 'node:fs';fs.writeFileSync(process.env.SYNC_FILTER_MARKER,'ran');process.stdout.write(fs.readFileSync(0));\n"); commit(f.root);
  git(f.root, "config", "filter.probe.clean", JSON.stringify(process.execPath) + " " + JSON.stringify(scriptPath));
  const old = process.env.SYNC_FILTER_MARKER; process.env.SYNC_FILTER_MARKER = marker;
  t.after(() => { if (old === undefined) delete process.env.SYNC_FILTER_MARKER; else process.env.SYNC_FILTER_MARKER = old; });
  put(f.root, "target.txt", "foobar\n"); const future = new Date(Date.now() + 2000); utimesSync(join(f.root, "target.txt"), future, future);
  inspectProject({ root: f.root, catalog: f.catalog });
  assert.equal(existsSync(marker), false);
});

test("catalog refresh resolves an immutable revision and rejects edited snapshot bytes", async (t) => {
  const f = fixture(t);
  const revision = git(f.source, "rev-parse", "HEAD");
  const calls = [];
  const fetcher = async (url) => { calls.push(url); return new Response(url.includes("/commits/") ? JSON.stringify({ sha: revision }) : readFileSync(f.catalogPath, "utf8")); };
  const before = git(f.root, "status", "--porcelain");
  const snapshot = await refreshCatalog({ catalog: f.catalog, directory: join(f.base, "download"), fetcher });
  assert.equal(snapshot.source.revision, revision);
  assert.equal(loadCatalog(snapshot.path).hash, f.catalog.hash);
  assert.ok(calls[1].includes("/" + revision + "/" + OWNER_CATALOG_PATH));
  assert.equal(git(f.root, "status", "--porcelain"), before);
  writeFileSync(snapshot.path, readFileSync(snapshot.path, "utf8") + "\n# Changed after acquisition\n");
  assert.throws(() => loadCatalog(snapshot.path), /snapshot content changed/);
  await assert.rejects(() => refreshCatalog({ catalog: f.catalog, directory: f.root, fetcher }), /fresh catalog snapshot directory/);
  assert.ok(existsSync(join(f.root, "README.md")));
  const unsafe = join(f.root, "catalog-download");
  await assert.rejects(() => refreshCatalog({ catalog: f.catalog, root: f.root, directory: unsafe, fetcher: async () => { throw new Error("Must reject storage before networking"); } }), /outside target and source/);
  assert.equal(existsSync(unsafe), false);
  const redirect = join(f.base, "temporary-redirect"); symlinkSync(f.root, redirect);
  await assert.rejects(() => refreshCatalog({ catalog: f.catalog, root: f.root, directory: join(redirect, "catalog-download"), fetcher: async () => { throw new Error("Must reject redirected storage first"); } }), /outside target and source/);
  assert.equal(existsSync(unsafe), false);
});

test("fresh catalog provenance is bound to the stage and lock even when definitions match", async (t) => {
  const f = fixture(t);
  const revision = git(f.source, "rev-parse", "HEAD");
  const download = async (name, sha) => refreshCatalog({ catalog: f.catalog, directory: join(f.base, name), fetcher: async (url) => new Response(url.includes("/commits/") ? JSON.stringify({ sha }) : readFileSync(f.catalogPath, "utf8")) });
  const first = loadCatalog((await download("first", revision)).path);
  await f.prepare(["alpha"], { catalog: first });
  const plan = f.plan(f.selection(), { catalog: first });
  assert.equal(plan.lock.catalogSource.revision, revision);
  const second = loadCatalog((await download("second", "b".repeat(40))).path);
  assert.equal(first.hash, second.hash);
  assert.throws(() => f.plan(f.selection(), { catalog: second }), /snapshot changed/);
  f.apply(f.selection(), { catalog: first });
  assert.equal(JSON.parse(readFileSync(join(f.root, LOCK_PATH), "utf8")).catalogSource.revision, revision);
  put(f.source, ".agents/skills/alpha/reference.md", "Uncommitted source edit.\n");
  await assert.rejects(() => f.prepare(["alpha"], { catalog: first, stage: join(f.base, "dirty-source-stage") }), /does not match the refreshed snapshot/);
});

test("authored acquisition uses the catalog commit rather than resolving a moving branch again", async (t) => {
  const f = fixture(t);
  const revision = "c".repeat(40); const calls = [];
  const files = [".agents/skills/alpha/SKILL.md", ".agents/skills/alpha/reference.md", "LICENSE"];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: revision }));
    if (url.endsWith("/assets/skill-catalog.yaml")) return new Response(readFileSync(f.catalogPath, "utf8"));
    if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: files.map((path) => ({ path, type: "blob", mode: "100644" })) }));
    const path = files.find((file) => url.endsWith("/" + file));
    assert.ok(path, url);
    assert.ok(url.includes("/" + revision + "/"), url);
    return new Response(readFileSync(join(f.source, path)));
  };
  const snapshot = await refreshCatalog({ catalog: f.catalog, directory: join(f.base, "catalog-pin"), fetcher });
  await prepareSkills({ catalog: loadCatalog(snapshot.path), root: f.root, stage: f.stage, names: ["alpha"], allowFetch: true, fetcher });
  assert.equal(calls.filter((url) => url.includes("/commits/")).length, 1);
  assert.ok(existsSync(join(f.stage, "skills/alpha/reference.md")));
});

test("catalog data cannot restore the retired manager or make the personal manager a project skill", (t) => {
  const f = fixture(t);
  for (const [name, message] of [["sync-my-skills", /must remain personal/], ["sync-agent-assets", /retired manager/]]) {
    const data = structuredClone(f.data); data.skills[name] = structuredClone(data.skills.alpha);
    const path = join(f.base, name + ".yaml"); writeFileSync(path, stringify(data));
    assert.throws(() => loadCatalog(path), message);
  }
});

test("incompatible or redirected catalogs stop without replacing code or retaining invalid downloads", async (t) => {
  const f = fixture(t);
  const before = digest(readFileSync(script));
  for (const [name, mutate] of [["version", (data) => { data.schemaVersion = 999; }], ["owner", (data) => { data.repository = "https://github.com/elsewhere/skills"; }], ["ref", (data) => { data.ref = "different-branch"; }]]) {
    const data = structuredClone(f.data); mutate(data);
    const directory = join(f.base, name);
    await assert.rejects(() => refreshCatalog({ catalog: f.catalog, directory, fetcher: async (url) => new Response(url.includes("/commits/") ? JSON.stringify({ sha: "a".repeat(40) }) : stringify(data)) }));
    assert.equal(existsSync(directory), false);
  }
  assert.equal(digest(readFileSync(script)), before);
  assert.equal(existsSync(join(f.root, ".agents")), false);
});

test("CLI inspect refreshes by default and exposes new catalog entries; bundled mode does not fetch", (t) => {
  const f = fixture(t);
  const data = parseYaml(readFileSync(join(PACKAGE_ROOT, "assets/skill-catalog.yaml"), "utf8"));
  data.skills["new-doc-guidance"] = { ...structuredClone(data.skills["document-project"]), source: { type: "local", path: ".agents/skills/new-doc-guidance" } };
  const stub = join(f.base, "fetch-stub.mjs");
  writeFileSync(stub, `globalThis.fetch = async (url) => new Response(url.includes('/commits/') ? JSON.stringify({sha: '${"d".repeat(40)}'}) : ${JSON.stringify(stringify(data))});\n`);
  const fresh = spawnSync(process.execPath, ["--import", stub, script, "inspect", "--root", f.root], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  const output = JSON.parse(fresh.stdout);
  const directory = dirname(output.catalogSnapshot.path);
  assert.ok(directory.startsWith(join(tmpdir(), "sync-my-skills-catalog-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(output.catalogSnapshot.mode, "refreshed");
  assert.equal(output.catalogSnapshot.source.revision, "d".repeat(40));
  assert.ok(output.recommendedSkills.some((entry) => entry.name === "new-doc-guidance"));
  writeFileSync(stub, "globalThis.fetch = async () => { throw new Error('Unexpected network call'); };\n");
  const offline = spawnSync(process.execPath, ["--import", stub, script, "inspect", "--root", f.root, "--bundled"], { encoding: "utf8" });
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(JSON.parse(offline.stdout).catalogSnapshot.mode, "bundled");
  const local = spawnSync(process.execPath, ["--import", stub, script, "inspect", "--root", f.root, "--source-root", repository], { encoding: "utf8" });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(JSON.parse(local.stdout).catalogSnapshot.mode, "local-source");
  assert.equal(existsSync(join(f.root, ".agents")), false);
});

test("CLI refresh failures never silently fall back or self-update", (t) => {
  const f = fixture(t); const stub = join(f.base, "unavailable.mjs");
  put(f.base, "unavailable.mjs", "globalThis.fetch = async () => new Response('Unavailable', {status: 503});\n");
  const failed = spawnSync(process.execPath, ["--import", stub, script, "inspect", "--root", f.root], { encoding: "utf8" });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /Manager code was not updated/);
  assert.match(failed.stderr, /no automatic fallback/);
  assert.equal(existsSync(join(f.root, ".agents")), false);
});

test("baseline recommendations remain explicit choices and can all be declined", async (t) => {
  const f = fixture(t, ({ data }) => { data.skills.alpha.selection = "recommended"; });
  const before = git(f.root, "status", "--porcelain");
  const inspection = inspectProject({ root: f.root, catalog: f.catalog });
  assert.deepEqual(inspection.recommendedSkills.map((s) => s.name), ["alpha"]);
  assert.ok(inspection.recommendedSkills[0].reasons.includes("catalog baseline recommendation"));
  assert.deepEqual(inspection.remainingSkills.map((s) => s.name), ["beta"]);
  await f.prepare([]);
  const plan = f.plan(f.selection([]));
  assert.deepEqual(plan.selection.selectedSkills, []);
  assert.equal(plan.actions.some((a) => a.path.startsWith(".agents/skills/")), false);
  assert.equal(git(f.root, "status", "--porcelain"), before);
});

test("documentation guidance is recommended without language signals or site initialization", (t) => {
  const f = fixture(t);
  const catalog = loadCatalog(join(PACKAGE_ROOT, "assets/skill-catalog.yaml"), repository);
  const before = git(f.root, "status", "--porcelain");
  const result = inspectProject({ root: f.root, catalog });
  for (const name of ["document-project", "asd-ste100-technical", "unslop"]) {
    const item = result.recommendedSkills.find((entry) => entry.name === name);
    assert.ok(item, name);
    assert.ok(item.reasons.includes("catalog baseline recommendation"), name);
    assert.equal(catalog.byName.get(name).selection, "recommended");
  }
  assert.ok(!result.recommendedSkills.some((entry) => entry.name === "coding" || entry.name === "coding-with-rules"));
  assert.equal(existsSync(join(f.root, "docs")), false);
  assert.equal(existsSync(join(f.root, ".agents")), false);
  assert.equal(git(f.root, "status", "--porcelain"), before);
});

test("documentation routing resolves local and upstream sources without forced project prerequisites", () => {
  const catalog = loadCatalog(join(PACKAGE_ROOT, "assets/skill-catalog.yaml"), repository);
  const route = readFileSync(join(repository, "AGENTS.md"), "utf8").split("\n").find((line) => line.startsWith("| During implementation,"));
  assert.ok(route);
  for (const name of ["document-project", "asd-ste100-technical", "unslop"]) {
    assert.ok(route.includes("`" + name + "`"), name);
    assert.deepEqual(catalog.byName.get(name).prerequisites, []);
    assert.equal(catalog.byName.get(name).scope, "project");
  }
  assert.equal(catalog.byName.get("unslop").kind, "upstream");
  assert.equal(existsSync(join(repository, ".claude/skills")), false);
  const dir = join(repository, catalog.byName.get("document-project").source.path);
  const instructions = readFileSync(join(dir, "SKILL.md"), "utf8");
  assert.doesNotMatch(instructions, /^requires:/m);
  for (const name of ["vitepress", "mkdocs", "examples"]) assert.ok(statSync(join(dir, "references", name + ".md")).isFile());
  const contributing = readFileSync(join(repository, "CONTRIBUTING.md"), "utf8");
  assert.match(contributing, /Update affected documentation in the same change before marking the work complete/);
  assert.match(contributing, /Required documentation is part of completing the change/);
});

test("documentation remains task-based and supports existing MkDocs sites", () => {
  const catalog = loadCatalog(undefined, repository);
  const dir = join(repository, catalog.byName.get("document-project").source.path);
  const instructions = readFileSync(join(dir, "SKILL.md"), "utf8");
  assert.match(instructions, /Assume familiarity with terminals, editors, files, and standard development tools/);
  assert.match(instructions, /Do not skip project-specific steps merely because the reader is a developer/);
  assert.match(instructions, /Keep existing MkDocs sites on MkDocs; improving documentation does not require migration/);
  assert.match(instructions, /Any platform change still needs explicit approval/);
  const examples = readFileSync(join(dir, "references/examples.md"), "utf8");
  assert.match(examples, /scripts\/sync-my-skills\.mjs catalog --source-root \./);
  assert.doesNotMatch(examples, /scripts\/sync-agent-assets\.mjs|prints JSON containing `profiles`/);
  const mkdocs = readFileSync(join(dir, "references/mkdocs.md"), "utf8");
  assert.match(mkdocs, /mkdocs build --strict/);
  assert.match(mkdocs, /mkdocs\.yml/);
});

test("inventory skips unrelated project links, reports known deprecations, and preserves custom names", (t) => {
  const f = fixture(t, ({ primary, base }) => {
    put(primary, ".agents/skills/coding-ts/SKILL.md", skill("coding-ts"));
    put(primary, ".agents/skills/coding-custom/SKILL.md", skill("coding-custom"));
    put(primary, "outside.txt", "Keep.\n");
    symlinkSync(join(base, "not-present"), join(primary, "unrelated-link"));
    put(primary, ".opencode/.keep", "Harness configuration directory.\n");
  });
  const result = inspectProject({ root: f.root, catalog: f.catalog });
  assert.deepEqual(result.deprecatedSkills.map((s) => s.name), ["coding-ts"]);
  assert.equal(result.deprecatedSkills[0].changedFiles, null);
  assert.ok(result.installedSkills.some((s) => s.name === "coding-custom" && !s.deprecated));
  assert.deepEqual(result.installedSkills.find((s) => s.name === "coding-custom").locations[0].state, { type: "directory" });
  assert.deepEqual(result.detectedHarnesses, ["opencode"]);
});

test("preparation keeps supporting/legal files, excludes OpenAI metadata, and leaves target untouched", async (t) => {
  const f = fixture(t, ({ source }) => put(source, ".agents/skills/alpha/agents/openai.yaml", "interface: {}\n"));
  const before = git(f.root, "status", "--porcelain");
  await f.prepare();
  assert.ok(existsSync(join(f.stage, "skills/alpha/reference.md")));
  assert.equal(readFileSync(join(f.stage, "skills/alpha/LICENSE"), "utf8"), "MIT License\nCopyright Fixture\n");
  assert.equal(existsSync(join(f.stage, "skills/alpha/agents/openai.yaml")), false);
  assert.equal(git(f.root, "status", "--porcelain"), before);
  await assert.rejects(() => f.prepare(), /fresh stage/);
  await assert.rejects(() => prepareSkills({ catalog: f.catalog, names: ["alpha"], stage: join(f.root, "stage"), sourceRoot: f.source, root: f.root }), /outside the target/);
});

test("project source declarations cannot escape through a linked skill directory", (t) => {
  const f = fixture(t);
  rmSync(join(f.source, ".agents/skills/alpha"), { recursive: true });
  symlinkSync(join(f.source, ".agents/skills/beta"), join(f.source, ".agents/skills/alpha"));
  assert.throws(() => loadCatalog(f.catalogPath, f.source), /Symlink/);
});

test("selection requires a decision for every remaining entry and confirms harness compatibility", async (t) => {
  const f = fixture(t); await f.prepare();
  assert.throws(() => f.plan({ selectedSkills: ["alpha"], declinedSkills: [], harnesses: ["pi"] }), /remaining catalog skills: beta/);
  assert.throws(() => f.plan(f.selection(["alpha"], { harnesses: [] })), /at least one/);
  assert.throws(() => f.plan(f.selection(["alpha"], { harnesses: ["unknown"] })), /supported harness/);
  assert.throws(() => f.plan(f.selection(["alpha"], { rootFiles: ["AGENTS.md"] })), /Legacy rootFiles does not authorize/);
  assert.throws(() => f.plan(f.selection(["alpha"], { removeSkills: ["alpha"] })), /not a catalogued deprecation/);
});

test("prerequisites are installed by closure and unsupported harness selections stop", async (t) => {
  const f = fixture(t, ({ data, source }) => {
    data.skills.alpha.prerequisites = ["beta"];
    data.skills.beta.harnesses = ["pi"];
    put(source, ".agents/skills/alpha/SKILL.md", skill("alpha", "Body", ["beta"]));
  });
  assert.deepEqual(closure(["alpha"], f.catalog), ["alpha", "beta"]);
  await f.prepare();
  assert.deepEqual(f.plan().selection.selectedSkills, ["alpha", "beta"]);
  assert.throws(() => f.plan(f.selection(["alpha"], { harnesses: ["claude-code"] })), /Incompatible/);
});

test("a valid plan is read-only and apply needs flags, an exact plan, and a worktree", async (t) => {
  const f = fixture(t); await f.prepare();
  const input = f.selection(); const plan = f.plan(input);
  assert.equal(existsSync(join(f.root, ".agents")), false);
  assert.throws(() => applySync({ root: f.root, stage: f.stage, selection: input, catalog: f.catalog }), /--apply --confirm/);
  assert.throws(() => f.apply(input, { planId: "0".repeat(64) }), /stale/);
  const primaryPlan = f.plan(input, { root: f.primary });
  assert.throws(() => applySync({ root: f.primary, stage: f.stage, selection: input, catalog: f.catalog, apply: true, confirm: true, planId: primaryPlan.planId }), /primary checkout/);
  assert.equal(existsSync(join(f.primary, ".agents")), false);
  const instructions = Object.fromEntries(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "VALIDATION.md", "README.md"].map((p) => [p, readFileSync(join(f.root, p), "utf8")]));
  const applied = applySync({ root: f.root, stage: f.stage, selection: input, catalog: f.catalog, apply: true, confirm: true, planId: plan.planId });
  assert.equal(applied.mode, "applied");
  assert.ok(existsSync(join(f.root, ".agents/skills/alpha/reference.md")));
  assert.equal(existsSync(join(f.root, ".claude")), false);
  for (const [path, text] of Object.entries(instructions)) assert.equal(readFileSync(join(f.root, path), "utf8"), text);
  assert.ok(projectStatus(f.root).files.every((file) => file.state === "clean"));
  const lock = readFileSync(join(f.root, LOCK_PATH), "utf8");
  assert.equal(lock.includes(f.base), false);
  assert.equal(JSON.parse(lock).schemaVersion, 3);
  assert.equal(existsSync(join(f.root, "skills-lock.json")), false);
});

test("Claude projections are exact relative links and are not forced for Pi/OpenCode", async (t) => {
  const f = fixture(t); await f.prepare();
  f.apply(f.selection(["alpha"], { harnesses: ["opencode", "claude-code"] }));
  assert.equal(readlinkSync(join(f.root, ".claude/skills/alpha")), "../../.agents/skills/alpha");
  assert.equal(existsSync(join(f.root, ".pi")), false);
  assert.equal(projectStatus(f.root).projections[0].state, "clean");
});

test("projection conflicts require exact notes and cannot be overwritten silently", async (t) => {
  const f = fixture(t, ({ primary }) => put(primary, ".claude/skills/alpha/custom.txt", "Preserve until approved.\n"));
  await f.prepare();
  const selection = f.selection(["alpha"], { harnesses: ["claude-code"] });
  assert.throws(() => f.plan(selection), /Projection conflict/);
  selection.resolutions = { ".claude/skills/alpha": "Owner chose replacement of this exact directory after reviewing its contents." };
  f.apply(selection);
  assert.equal(readlinkSync(join(f.root, ".claude/skills/alpha")), "../../.agents/skills/alpha");
});

test("local/unmanaged edits require reviewed resolutions; stale target state is never adopted", async (t) => {
  const f = fixture(t); await f.prepare(); f.apply();
  const path = ".agents/skills/alpha/SKILL.md";
  put(f.root, path, skill("alpha", "Locally edited."));
  assert.throws(() => f.plan(), /Local\/unmanaged change/);
  const input = f.selection(["alpha"], { resolutions: { [path]: "Owner chose the staged version after reviewing the local diff." } });
  const plan = f.plan(input);
  put(f.root, path, skill("alpha", "Another edit after approval."));
  assert.throws(() => applySync({ root: f.root, stage: f.stage, selection: input, catalog: f.catalog, apply: true, confirm: true, planId: plan.planId }), /stale/);
  assert.match(readFileSync(join(f.root, path), "utf8"), /Another edit/);
});

test("adapted skills require output-bound review and preserve legal notices", async (t) => {
  const f = fixture(t, ({ data }) => { data.skills.alpha.kind = "adapted"; data.skills.alpha.adaptation = { instructions: "Preserve behavior; use portable tool instructions." }; });
  const prep = await f.prepare(); assert.deepEqual(prep.needsReview, ["alpha"]);
  assert.throws(() => f.plan(), /Adaptation review required/);
  put(f.stage, "skills/alpha/SKILL.md", skill("alpha", "Portable adapted instructions."));
  reviewSkill({ stage: f.stage, name: "alpha", note: "Replaced a provider-specific call while preserving the workflow." });
  const plan = f.plan(); assert.ok(plan.lock.skills.alpha.review.note.includes("preserving"));
  put(f.stage, "skills/alpha/SKILL.md", skill("alpha", "An unreviewed further edit."));
  assert.throws(() => f.plan(), /Adaptation review required/);
  reviewSkill({ stage: f.stage, name: "alpha", note: "Reviewed the further edit." });
  put(f.stage, "skills/alpha/LICENSE", "Changed legal notice.\n");
  reviewSkill({ stage: f.stage, name: "alpha", note: "Cannot waive legal checks." });
  assert.throws(() => f.plan(), /Legal notice changed/);
});

test("raw source tampering and excluded output files invalidate preparation/review", async (t) => {
  const f = fixture(t); await f.prepare();
  put(f.stage, "skills/alpha/agents/openai.yaml", "interface: {}\n");
  assert.throws(() => f.plan(), /Forbidden\/excluded/);
  rmSync(join(f.stage, "skills/alpha/agents/openai.yaml"));
  put(f.stage, "raw/alpha/SKILL.md", skill("alpha", "Tampered raw input."));
  assert.throws(() => reviewSkill({ stage: f.stage, name: "alpha", note: "Review" }), /Raw source changed/);
  assert.throws(() => f.plan(), /Raw source changed/);
});

test("unchanged approved adaptation is reused; target context changes require a fresh review", async (t) => {
  const f = fixture(t, ({ data }) => { data.skills.alpha.kind = "adapted"; data.skills.alpha.adaptation = { instructions: "Keep a portable workflow." }; });
  await f.prepare();
  put(f.stage, "skills/alpha/SKILL.md", skill("alpha", "Reviewed portable variant."));
  reviewSkill({ stage: f.stage, name: "alpha", note: "Preserved the intended behavior." });
  f.apply();
  const stage2 = join(f.base, "stage2");
  const reused = await f.prepare(["alpha"], { stage: stage2 });
  assert.deepEqual(reused.needsReview, []);
  assert.match(readFileSync(join(stage2, "skills/alpha/SKILL.md"), "utf8"), /portable variant/);
  put(f.root, "AGENTS.md", "New project instructions.\n");
  assert.throws(() => f.plan(f.selection(), { stage: stage2 }), /Target requirements changed/);
  const fresh = await f.prepare(["alpha"], { stage: join(f.base, "stage3") });
  assert.deepEqual(fresh.needsReview, ["alpha"]);
});

test("known deprecated removals bind full trees; custom similarly named skills remain", async (t) => {
  const f = fixture(t, ({ primary }) => {
    put(primary, ".agents/skills/coding-ts/SKILL.md", skill("coding-ts"));
    put(primary, ".agents/skills/coding-ts/local-notes.md", "Unmanaged notes to disclose.\n");
    put(primary, ".agents/skills/coding-custom/SKILL.md", skill("coding-custom"));
    mkdirSync(join(primary, ".claude/skills"), { recursive: true });
    symlinkSync("../../.agents/skills/coding-ts", join(primary, ".claude/skills/coding-ts"));
  });
  await f.prepare();
  assert.equal(f.plan().actions.some((a) => a.op === "remove-skill"), false);
  assert.throws(() => f.plan(f.selection(["alpha"], { removeSkills: ["coding-custom"] })), /not a catalogued deprecation/);
  const input = f.selection(["alpha"], { removeSkills: ["coding-ts"] });
  const plan = f.plan(input);
  put(f.root, ".agents/skills/coding-ts/new-file.md", "Added after review.\n");
  assert.throws(() => applySync({ root: f.root, stage: f.stage, selection: input, catalog: f.catalog, apply: true, confirm: true, planId: plan.planId }), /stale/);
  f.apply(input);
  assert.equal(existsSync(join(f.root, ".agents/skills/coding-ts")), false);
  assert.equal(existsSync(join(f.root, ".claude/skills/coding-ts")), false);
  assert.ok(existsSync(join(f.root, ".agents/skills/coding-custom/SKILL.md")));
});

for (const entryType of ["directory", "file"]) {
  test(`removal snapshots do not follow a ${entryType} replaced after directory listing`, async (t) => {
    const f = fixture(t, ({ primary, base }) => {
      put(primary, ".agents/skills/coding-ts/SKILL.md", skill("coding-ts"));
      put(primary, entryType === "directory" ? ".agents/skills/coding-ts/docs/note.md" : ".agents/skills/coding-ts/note.md", "Local notes.\n");
      put(base, "outside/secret.md", "Outside the installation.\n");
    });
    await f.prepare();
    const legacy = join(f.root, ".agents/skills/coding-ts");
    const victim = join(legacy, entryType === "directory" ? "docs" : "note.md");
    const outside = join(f.base, "outside", ...(entryType === "file" ? ["secret.md"] : []));
    const readdir = fs.readdirSync; const read = fs.readFileSync;
    let swapped = false; let outsideRead = false;
    t.mock.method(fs, "readdirSync", (...args) => {
      const entries = readdir(...args);
      if (args[0] === legacy && !swapped) {
        swapped = true; fs.renameSync(victim, `${victim}-saved`); symlinkSync(outside, victim);
      }
      return entries;
    });
    t.mock.method(fs, "readFileSync", (...args) => {
      if (args[0] === victim || typeof args[0] === "string" && args[0].startsWith(`${victim}/`)) outsideRead = true;
      return read(...args);
    });
    syncBuiltinESMExports();
    try {
      f.plan(f.selection(["alpha"], { removeSkills: ["coding-ts"] }));
      assert.equal(swapped, true);
      assert.equal(outsideRead, false, "Fingerprinting must not read through the substituted link");
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

test("removal snapshots stop when a directory changes during its own listing", async (t) => {
  const f = fixture(t, ({ primary, base }) => {
    put(primary, ".agents/skills/coding-ts/SKILL.md", skill("coding-ts"));
    put(primary, ".agents/skills/coding-ts/docs/note.md", "Local notes.\n");
    put(base, "outside/secret.md", "Outside the installation.\n");
  });
  await f.prepare();
  const dir = join(f.root, ".agents/skills/coding-ts/docs");
  const readdir = fs.readdirSync; let changed = false;
  t.mock.method(fs, "readdirSync", (...args) => {
    const entries = readdir(...args);
    if (args[0] === dir && !changed) {
      changed = true; fs.renameSync(dir, `${dir}-saved`); symlinkSync(join(f.base, "outside"), dir);
    }
    return entries;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.plan(f.selection(["alpha"], { removeSkills: ["coding-ts"] })), /Symlink traversal|Removal directory changed/);
    assert.equal(changed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("regular-file snapshots reject a link substituted at open time", async (t) => {
  const f = fixture(t, ({ primary, base }) => {
    put(primary, ".agents/skills/coding-ts/SKILL.md", skill("coding-ts"));
    put(primary, ".agents/skills/coding-ts/note.md", "Local notes.\n");
    put(base, "outside.md", "Outside the installation.\n");
  });
  await f.prepare();
  const victim = join(f.root, ".agents/skills/coding-ts/note.md");
  const open = fs.openSync; let changed = false;
  t.mock.method(fs, "openSync", (...args) => {
    if (args[0] === victim && !changed) {
      changed = true; fs.renameSync(victim, `${victim}-saved`); symlinkSync(join(f.base, "outside.md"), victim);
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.plan(f.selection(["alpha"], { removeSkills: ["coding-ts"] })), /ELOOP|Symlink traversal|File changed while opening/);
    assert.equal(changed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const scope of ["target", "source"]) {
  test(`preparation rejects a stage whose symlinked ancestor enters the ${scope}`, async (t) => {
    const f = fixture(t);
    const repositoryRoot = scope === "target" ? f.root : f.source;
    const alias = join(f.base, "repository-alias"); symlinkSync(repositoryRoot, alias);
    const stage = join(alias, "missing-parent", "stage");
    await assert.rejects(() => f.prepare(["alpha"], { stage }), /Stage must be outside/);
    assert.equal(existsSync(join(repositoryRoot, "missing-parent")), false);
  });
}

test("preparation permits fresh external stages beneath missing parent directories", async (t) => {
  const f = fixture(t); const stage = join(f.base, "new-parent", "nested", "stage");
  const result = await f.prepare(["alpha"], { stage });
  assert.equal(result.stage, stage);
  assert.equal(existsSync(join(stage, "skills/alpha/SKILL.md")), true);
});

test("real install sources match grouped paths and never require the personal manager", () => {
  const catalog = loadCatalog(undefined, repository);
  for (const entry of catalog.skills) {
    const source = entry.source;
    const expected = source.type === "local"
      ? `${catalog.repository}/tree/${catalog.ref}/${source.path}`
      : `${source.repository}/tree/${source.revision}/${source.path}`;
    assert.equal(entry.install.argv[4], expected, entry.name);
    assert.deepEqual(entry.install.argv.slice(0, 4), ["npx", "-y", "skills@1.7.4", "add"]);
    assert.equal(entry.install.argv[entry.install.argv.indexOf("--skill") + 1], entry.name);
    if (entry.name !== "sync-my-skills") assert.ok(!entry.prerequisites.includes("sync-my-skills"));
    if (source.type === "local") assert.ok(existsSync(join(repository, source.path, "SKILL.md")));
  }
});

test("Archify remains an optional pinned external reference with protected legal notices", () => {
  const catalog = loadCatalog(undefined, repository); const entry = catalog.byName.get("archify");
  assert.equal(entry.kind, "upstream"); assert.equal(entry.selection, "optional");
  assert.deepEqual(entry.source, { type: "github", repository: "https://github.com/tt-a1i/archify", revision: "a7ed6fd6657da90414831d1d42cf95987188750c", path: "archify" });
  assert.deepEqual(entry.prerequisites, []); assert.equal(entry.signals.askWithoutSignals, true);
  assert.deepEqual(entry.install.argv.slice(0, 4), ["npx", "-y", "skills@1.7.4", "add"]);
  assert.ok(entry.install.argv[4].includes(`/tree/${entry.source.revision}/archify`));
  assert.deepEqual(entry.legal.map(({ path, target, spdx }) => [path, target, spdx]), [
    ["archify/LICENSE", "LICENSE", "Apache-2.0"],
    ["archify/LICENSE-MIT", "LICENSE-MIT", "MIT"],
    ["archify/NOTICE", "NOTICE", "NOASSERTION"],
    ["archify/THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md", "NOASSERTION"],
    ["archify/assets/JetBrainsMono-OFL.txt", "assets/JetBrainsMono-OFL.txt", "OFL-1.1"],
    ["archify/explainer/vendor/pele/LICENSE", "explainer/vendor/pele/LICENSE", "MIT"],
  ]);
  assert.equal(existsSync(join(repository, ".agents/skills/archify")), false);
  assert.equal(existsSync(join(repository, ".claude/skills/archify")), false);
});

test("Archify acquisition keeps supporting and legal files while excluding provider metadata", async (t) => {
  const f = fixture(t); const catalog = loadCatalog(undefined, repository); const entry = catalog.byName.get("archify");
  const files = new Map([
    ["archify/SKILL.md", skill("archify")],
    ["archify/bin/archify.mjs", "// Unexecuted fixture data.\n"],
    ["archify/references/delivery-contract.md", "# Delivery verification\n"],
    ["archify/agents/openai.yaml", "Unwanted provider metadata.\n"],
    ["archify/nested/agents/openai.yaml", "Unwanted nested metadata.\n"],
  ]);
  for (const legal of entry.legal) files.set(legal.path, `Fixture notice ${legal.path}\n`);
  const raw = `https://raw.githubusercontent.com/tt-a1i/archify/${entry.source.revision}/`;
  const fetcher = async (url) => {
    if (url === `https://api.github.com/repos/tt-a1i/archify/git/trees/${entry.source.revision}?recursive=1`) {
      return new Response(JSON.stringify({ truncated: false, tree: [...files.keys()].map((path) => ({ path, type: "blob", mode: "100644" })) }));
    }
    assert.ok(url.startsWith(raw), `Unexpected acquisition URL: ${url}`);
    const path = decodeURIComponent(url.slice(raw.length));
    assert.ok(!path.endsWith("agents/openai.yaml"), "Excluded metadata must not be fetched");
    return files.has(path) ? new Response(files.get(path)) : new Response("Missing", { status: 404 });
  };
  const stage = join(f.base, "archify-stage");
  await prepareSkills({ catalog, names: ["archify"], stage, root: f.root, allowFetch: true, fetcher });
  const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
  assert.equal(manifest.skills.archify.kind, "upstream");
  assert.equal(manifest.skills.archify.origin.revision, entry.source.revision);
  for (const legal of entry.legal) {
    assert.equal(readFileSync(join(stage, "skills/archify", legal.target), "utf8"), files.get(legal.path));
  }
  assert.equal(readFileSync(join(stage, "skills/archify/bin/archify.mjs"), "utf8"), files.get("archify/bin/archify.mjs"));
  assert.equal(existsSync(join(stage, "skills/archify/agents/openai.yaml")), false);
  assert.equal(existsSync(join(stage, "skills/archify/nested/agents/openai.yaml")), false);
  assert.equal(existsSync(join(f.root, ".agents/skills/archify")), false);
});

test("incoming Excalidraw registration stages its complete package without executing tools", async (t) => {
  const f = fixture(t); const catalog = loadCatalog(undefined, repository); const entry = catalog.byName.get("excalidraw");
  assert.equal(entry.kind, "authored"); assert.equal(entry.selection, "optional");
  assert.deepEqual(entry.prerequisites, []); assert.equal(entry.signals.askWithoutSignals, true);
  assert.ok(entry.runtime.some((rule) => rule.includes("@excalidraw/cli 0.3.0")));
  const stage = join(f.base, "excalidraw-stage");
  await prepareSkills({ catalog, names: ["excalidraw"], stage, sourceRoot: repository, root: f.root });
  for (const file of ["README.md", "SKILL.md", "examples/project-structure.mmd", "LICENSE"]) {
    assert.equal(existsSync(join(stage, "skills/excalidraw", file)), true);
  }
  assert.equal(existsSync(join(f.root, ".agents/skills/excalidraw")), false);
});

test("apply rejects candidate bytes changed after the first target write", async (t) => {
  const f = fixture(t); await f.prepare();
  const plan = f.plan(); const writes = plan.actions.filter((action) => action.op === "write");
  assert.ok(writes.length >= 2);
  const first = join(f.root, writes[0].path); const later = writes[1];
  const rename = fs.renameSync; let changed = false;
  t.mock.method(fs, "renameSync", (...args) => {
    const result = rename(...args);
    if (args[1] === first && !changed) {
      changed = true; writeFileSync(join(f.stage, later.from), "Changed after approval.\n");
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    let failure;
    try { applySync({ root: f.root, stage: f.stage, catalog: f.catalog, selection: f.selection(), apply: true, confirm: true, planId: plan.planId }); }
    catch (error) { failure = error; }
    assert.equal(changed, true, "The race injection must run after the first target rename");
    assert.match(failure?.message ?? "", /Candidate changed/);
    assert.equal(existsSync(join(f.root, later.path)), false);
    assert.equal(existsSync(join(f.root, LOCK_PATH)), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("legacy instruction records migrate without managing or changing their documents", async (t) => {
  const f = fixture(t, ({ primary }) => {
    const hash = digest(readFileSync(join(primary, "AGENTS.md")));
    put(primary, LOCK_PATH, JSON.stringify({ schemaVersion: 1, files: { "AGENTS.md": { kind: "instruction", sourcePath: "AGENTS.md", sourceSha256: hash, installedSha256: hash } }, selection: { selectedSkills: [] }, projections: {} }));
  });
  await f.prepare(); const plan = f.plan();
  assert.equal(plan.legacyLockMigration, true);
  assert.equal(plan.lock.files["AGENTS.md"], undefined);
  assert.equal(plan.lock.legacyInstructions["AGENTS.md"].kind, "instruction");
  f.apply();
  assert.equal(readFileSync(join(f.root, "AGENTS.md"), "utf8"), "Respect existing project authority.\n");
});

test("declining an installed managed skill preserves its files and prior local-change baseline", async (t) => {
  const f = fixture(t); await f.prepare(["alpha", "beta"]); f.apply(f.selection(["alpha", "beta"]));
  put(f.root, ".agents/skills/beta/SKILL.md", skill("beta", "Local beta edit."));
  const stage2 = join(f.base, "stage2"); await f.prepare(["alpha"], { stage: stage2 });
  f.apply(f.selection(), { stage: stage2 });
  assert.match(readFileSync(join(f.root, ".agents/skills/beta/SKILL.md"), "utf8"), /Local beta edit/);
  assert.equal(projectStatus(f.root).files.find((f) => f.path === ".agents/skills/beta/SKILL.md").state, "modified-or-missing");
});

test("public GitHub acquisition fetches only selected files, records commit, and filters metadata", async (t) => {
  const f = fixture(t, ({ data, source }) => {
    data.skills.beta.kind = "upstream";
    data.skills.beta.source = { type: "github", repository: "https://github.com/example/upstream", revision: "a".repeat(40), path: "skills/beta" };
    rmSync(join(source, ".agents/skills/beta"), { recursive: true });
  });
  const requests = [];
  const fetcher = async (url) => {
    requests.push(url);
    if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [{ path: "skills/beta/SKILL.md", type: "blob", mode: "100644" }, { path: "skills/beta/agents/openai.yaml", type: "blob", mode: "100644" }, { path: "other/huge.bin", type: "blob", mode: "100644" }] }));
    if (url.endsWith("/skills/beta/SKILL.md")) return new Response(skill("beta"));
    if (url.endsWith("/LICENSE")) return new Response("MIT License\n");
    throw new Error("Unexpected source content request");
  };
  await assert.rejects(() => f.prepare(["beta"], { fetcher }), /--fetch permission/);
  await f.prepare(["beta"], { fetcher, allowFetch: true });
  assert.equal(requests.some((url) => url.includes("openai") || url.includes("huge.bin")), false);
  const manifest = JSON.parse(readFileSync(join(f.stage, "manifest.json"), "utf8"));
  assert.equal(manifest.skills.beta.origin.revision, "a".repeat(40));
  assert.equal(existsSync(join(f.stage, "skills/beta/agents/openai.yaml")), false);
  f.apply(f.selection(["beta"]));
});

test("source truncation and symbolic links stop before target activation", async (t) => {
  for (const mode of ["truncated", "symlink"]) {
    const f = fixture(t, ({ data, source }) => {
      data.skills.beta.kind = "upstream"; data.skills.beta.source = { type: "github", repository: "https://github.com/example/upstream", revision: "b".repeat(40), path: "skills/beta" };
      rmSync(join(source, ".agents/skills/beta"), { recursive: true });
    });
    const fetcher = async () => new Response(JSON.stringify({ truncated: mode === "truncated", tree: [{ path: "skills/beta/SKILL.md", type: "blob", mode: mode === "symlink" ? "120000" : "100644" }] }));
    await assert.rejects(() => f.prepare(["beta"], { fetcher, allowFetch: true }), /Incomplete|Symlink/);
    assert.equal(existsSync(join(f.root, ".agents")), false);
  }
});

test("selected updates explicitly remove unmanaged OpenAI metadata", async (t) => {
  const f = fixture(t, ({ primary }) => {
    put(primary, ".agents/skills/alpha/SKILL.md", skill("alpha"));
    put(primary, ".agents/skills/alpha/agents/openai.yaml", "interface: {display_name: Custom}\n");
  });
  await f.prepare();
  const plan = f.plan();
  assert.ok(plan.actions.some((a) => a.op === "remove-file" && a.path.endsWith("agents/openai.yaml")));
  f.apply();
  assert.equal(existsSync(join(f.root, ".agents/skills/alpha/agents/openai.yaml")), false);
});

test("legal files already in a local package cannot be rewritten by adaptation", async (t) => {
  const f = fixture(t, ({ source, data }) => {
    put(source, ".agents/skills/alpha/LICENSE", "Specific upstream copyright.\n");
    data.skills.alpha.legal = [];
    data.skills.alpha.kind = "adapted";
    data.skills.alpha.adaptation = { instructions: "Keep the maintained variant." };
  });
  await f.prepare();
  put(f.stage, "skills/alpha/LICENSE", "Incorrect replacement notice.\n");
  reviewSkill({ stage: f.stage, name: "alpha", note: "Review cannot waive legal preservation." });
  assert.throws(() => f.plan(), /Legal notice changed/);
});

test("personal setup is a separate approved plan with no model/provider overrides", (t) => {
  const f = fixture(t); const home = join(f.base, "home"); mkdirSync(home);
  const input = { home, managerRoot: PACKAGE_ROOT, harnesses: ["pi", "opencode", "claude-code"] };
  const plan = planSetup(input);
  assert.equal(existsSync(join(home, ".pi")), false);
  assert.throws(() => applySetup(input), /--apply --confirm/);
  applySetup({ ...input, apply: true, confirm: true, planId: plan.planId });
  for (const path of [".pi/agent/prompts/sync-my-skills.md", ".config/opencode/commands/sync-my-skills.md"]) {
    const text = readFileSync(join(home, path), "utf8"); assert.match(text, /\$ARGUMENTS/); assert.doesNotMatch(text, /^(model|agent):/m);
  }
  assert.ok(readlinkSync(join(home, ".claude/skills/sync-my-skills")));
  assert.deepEqual(planSetup(input).actions, []);
  put(home, ".pi/agent/prompts/sync-my-skills.md", "User's own command.\n");
  assert.throws(() => planSetup(input), /conflicts/);
});

test("a local checkout cannot be mislabeled as another upstream repository", async (t) => {
  const f = fixture(t);
  git(f.source, "remote", "set-url", "origin", "https://github.com/unrelated/source");
  await assert.rejects(() => f.prepare(), /origin does not match/);
  assert.equal(existsSync(f.stage), false);
});

test("source executable bits survive staging and installation", async (t) => {
  const f = fixture(t, ({ source }) => {
    put(source, ".agents/skills/alpha/scripts/run.sh", "#!/bin/sh\nexit 0\n");
    chmodSync(join(source, ".agents/skills/alpha/scripts/run.sh"), 0o755);
  });
  await f.prepare();
  assert.ok(statSync(join(f.stage, "skills/alpha/scripts/run.sh")).mode & 0o111);
  f.apply();
  assert.ok(statSync(join(f.root, ".agents/skills/alpha/scripts/run.sh")).mode & 0o111);
});

test("metadata removal does not duplicate a legacy managed-file removal", async (t) => {
  const f = fixture(t, ({ primary }) => {
    const path = ".agents/skills/alpha/agents/openai.yaml";
    put(primary, ".agents/skills/alpha/SKILL.md", skill("alpha"));
    put(primary, path, "interface: {}\n");
    const hash = digest(readFileSync(join(primary, path)));
    put(primary, LOCK_PATH, JSON.stringify({ schemaVersion: 1, files: { [path]: { kind: "skill", skill: "alpha", sourcePath: path, sourceSha256: hash, installedSha256: hash } }, projections: {} }));
  });
  await f.prepare();
  assert.equal(f.plan().actions.filter((a) => a.path.endsWith("agents/openai.yaml")).length, 1);
  f.apply();
});

test("CLI supports a deprecated-removal-only plan with no selected skills", (t) => {
  const f = fixture(t, ({ primary }) => put(primary, ".agents/skills/coding-ts/SKILL.md", skill("coding-ts")));
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const prepared = run(["prepare", "--root", f.root, "--stage", f.stage, "--source-root", f.source, "--catalog", f.catalogPath]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const file = join(f.base, "selection.json");
  put(f.base, "selection.json", JSON.stringify(f.selection([], { removeSkills: ["coding-ts"] })));
  const planned = run(["plan", "--root", f.root, "--stage", f.stage, "--catalog", f.catalogPath, "--selection", file]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  const applied = run(["apply", "--root", f.root, "--stage", f.stage, "--catalog", f.catalogPath, "--selection", file, "--apply", "--confirm", "--plan-id", plan.planId]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(join(f.root, ".agents/skills/coding-ts")), false);
  assert.equal(existsSync(join(f.root, ".agents/skills/alpha")), false);
});

test("unsupported locks, catalog changes, and target HEAD changes stop safely", async (t) => {
  const f = fixture(t); await f.prepare();
  put(f.root, LOCK_PATH, JSON.stringify({ schemaVersion: 99, files: {} }));
  assert.throws(() => f.plan(), /Unsupported/);
  rmSync(join(f.root, LOCK_PATH));
  const changed = structuredClone(f.data); changed.skills.alpha.description = "Changed selection guidance.";
  put(f.source, "changed.yaml", stringify(changed));
  assert.throws(() => f.plan(f.selection(), { catalog: loadCatalog(join(f.source, "changed.yaml")) }), /Catalog changed/);
  const plan = f.plan();
  git(f.root, "commit", "--allow-empty", "-qm", "Moved target HEAD");
  assert.throws(() => applySync({ root: f.root, stage: f.stage, catalog: f.catalog, selection: f.selection(), apply: true, confirm: true, planId: plan.planId }), /stale/);
  assert.equal(existsSync(join(f.root, ".agents/skills/alpha")), false);
});

test("malformed lock containers cannot be silently normalized into valid state", (t) => {
  const f = fixture(t);
  put(f.root, LOCK_PATH, JSON.stringify({ schemaVersion: 2, files: {}, skills: [] }));
  assert.throws(() => inspectProject({ root: f.root, catalog: f.catalog }), /lock/i);
});

test("a symlinked destination parent cannot redirect installation outside the project", async (t) => {
  const f = fixture(t); await f.prepare();
  const outside = join(f.base, "outside"); mkdirSync(outside);
  mkdirSync(join(f.root, ".agents")); symlinkSync(outside, join(f.root, ".agents/skills"));
  assert.throws(() => f.plan(), /Symlink/);
  assert.equal(existsSync(join(outside, "alpha")), false);
});

test("review notes cannot leak credentials or absolute machine paths into locks", async (t) => {
  const f = fixture(t, ({ data }) => { data.skills.alpha.kind = "adapted"; data.skills.alpha.adaptation = { instructions: "Preserve the workflow." }; });
  await f.prepare();
  reviewSkill({ stage: f.stage, name: "alpha", note: "/private/personal/path" });
  assert.throws(() => f.plan(), /absolute machine paths/);
  reviewSkill({ stage: f.stage, name: "alpha", note: "token ghp_abcdefghijklmnopqrstuvwxyz" });
  assert.throws(() => f.plan(), /credential material/);
});

const ROOT_BUNDLE = ["AGENTS.md", "CONTRIBUTING.md", "DOCUMENTATION.md", "VALIDATION.md"];
const ROOT_GUIDANCE = ["isolated-workspace", "document-project", "asd-ste100-technical", "unslop"];
function instructionFixture(t) {
  const f = fixture(t, ({ source, data }) => {
    for (const name of ROOT_GUIDANCE) {
      data.skills[name] = { ...structuredClone(data.skills.alpha), description: `Fixture ${name}.`, source: { type: "local", path: `.agents/skills/${name}` } };
      put(source, `.agents/skills/${name}/SKILL.md`, skill(name));
    }
    for (const file of ["README.md", ...[...ROOT_BUNDLE, "CLAUDE.md"].map((name) => name.replace(".md", ".template.md"))]) put(source, "templates/" + file, readFileSync(join(repository, "templates", file), "utf8"));
    data.instructionTemplates = { enabled: true, issue: 68, path: "templates", prerequisites: ROOT_GUIDANCE };
  });
  const choice = (files = ROOT_BUNDLE) => f.selection(ROOT_GUIDANCE, {
    instructionFiles: files,
    instructionApproval: "Owner explicitly approved the displayed instruction-policy changes.",
    resolutions: Object.fromEntries(files.filter((name) => existsSync(join(f.root, name))).map((name) => [name, "Preserve existing project rules while adopting the reviewed bundle."])),
  });
  function draft(files = ROOT_BUNDLE, stage = f.stage) {
    for (const name of files) {
      const template = readFileSync(join(stage, "templates", name.replace(".md", ".template.md")), "utf8");
      const values = { PROJECT_NAME: "Fixture project", PROJECT_PURPOSE: "A documentation-only fixture.", WORKFLOW_SETTINGS: "Use Git and change/ branches; the base is main.", PUBLICATION_POLICY: "Only the owner authorizes publication, merging, releases, and deployment.", DOCUMENTATION_ENGINE: "Markdown only. No site is approved." };
      const populated = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key] ?? "Verified fixture decision: no additional tool or policy is configured.");
      const old = existsSync(join(f.root, name)) ? readFileSync(join(f.root, name), "utf8") : "";
      put(stage, "instructions/" + name, populated + "\n" + old);
    }
  }
  return { ...f, choice, draft };
}

test("selected instruction bundles are reviewed, approval-bound, and managed with skill changes", async (t) => {
  const f = instructionFixture(t);
  await f.prepare(ROOT_GUIDANCE, { instructionFiles: ROOT_BUNDLE });
  assert.equal(existsSync(join(f.root, "DOCUMENTATION.md")), false);
  assert.throws(() => f.plan(f.choice()), /instruction.*review|unresolved|template/i);
  f.draft(); sync.reviewInstructions({ stage: f.stage, note: "Verified target facts, decisions, fixed gates, references, and preserved custom rules." });
  const plan = f.plan(f.choice());
  assert.ok(plan.actions.some((a) => a.path === "AGENTS.md"));
  f.apply(f.choice());
  assert.match(readFileSync(join(f.root, "AGENTS.md"), "utf8"), /Respect existing project authority/);
  assert.equal(readFileSync(join(f.root, "CLAUDE.md"), "utf8"), "Existing Claude instructions.\n");
  assert.ok(sync.projectStatus(f.root).files.filter((r) => ROOT_BUNDLE.includes(r.path)).every((r) => r.state === "clean"));
  const lock = JSON.parse(readFileSync(join(f.root, LOCK_PATH), "utf8"));
  assert.equal(lock.schemaVersion, 3); assert.ok(lock.instructions.origin.revision);
  assert.equal(lock.files["AGENTS.md"].kind, "instruction");
});

test("declining the instruction bundle keeps root documents unchanged and does not force guidance", async (t) => {
  const f = instructionFixture(t); const before = Object.fromEntries([...ROOT_BUNDLE, "CLAUDE.md"].map((p) => [p, existsSync(join(f.root, p)) ? readFileSync(join(f.root, p), "utf8") : null]));
  await f.prepare(["alpha"]); f.apply(f.selection(["alpha"]));
  for (const [p, text] of Object.entries(before)) assert.equal(existsSync(join(f.root, p)) ? readFileSync(join(f.root, p), "utf8") : null, text);
  assert.equal(existsSync(join(f.root, ".agents/skills/document-project")), false);
});

test("instruction prerequisites must be explicitly selected or valid installed guidance", async (t) => {
  const f = instructionFixture(t);
  await assert.rejects(() => f.prepare([], { instructionFiles: ROOT_BUNDLE }), /instruction prerequisite/i);
  assert.equal(existsSync(f.stage), false);
  for (const name of ROOT_GUIDANCE) put(f.root, `.agents/skills/${name}/SKILL.md`, skill(name));
  await f.prepare([], { instructionFiles: ROOT_BUNDLE }); f.draft();
  sync.reviewInstructions({ stage: f.stage, note: "Existing guidance was reviewed; no skill installation is requested." });
  const choice = f.selection([], { ...f.choice(), selectedSkills: [], declinedSkills: f.selection([]).declinedSkills });
  f.plan(choice);
  put(f.root, ".agents/skills/document-project/SKILL.md", skill("document-project", "Changed guidance after review."));
  assert.throws(() => f.plan(choice), /instruction prerequisite.*changed/i);
});

test("instruction review rejects unresolved fields, dropped fixed rules, and edited raw templates", async (t) => {
  const f = instructionFixture(t); await f.prepare(ROOT_GUIDANCE, { instructionFiles: ROOT_BUNDLE });
  assert.throws(() => sync.reviewInstructions({ stage: f.stage, note: "Not resolved yet." }), /unresolved|template/i);
  f.draft(); const path = join(f.stage, "instructions/AGENTS.md"); const valid = readFileSync(path, "utf8");
  writeFileSync(path, valid.replace("Never mutate the primary checkout.", ""));
  assert.throws(() => sync.reviewInstructions({ stage: f.stage, note: "Dropped a fixed rule." }), /template rule/i);
  writeFileSync(path, valid);
  put(f.stage, "templates/AGENTS.template.md", "Changed source template.\n");
  assert.throws(() => sync.reviewInstructions({ stage: f.stage, note: "Raw template changed." }), /template source.*changed/i);
});

test("instruction scope cannot expand through arbitrary paths, incomplete bundles, or missing policy approval", async (t) => {
  const f = instructionFixture(t); await f.prepare(ROOT_GUIDANCE, { instructionFiles: ROOT_BUNDLE }); f.draft();
  sync.reviewInstructions({ stage: f.stage, note: "Reviewed all candidates." });
  assert.throws(() => f.plan({ ...f.choice(), instructionFiles: ["README.md"] }), /instruction.*scope|bundle/i);
  assert.throws(() => f.plan({ ...f.choice(), instructionFiles: ["AGENTS.md"] }), /complete.*bundle|bundle.*complete/i);
  assert.throws(() => f.plan({ ...f.choice(), instructionApproval: "" }), /instruction.*approval/i);
  assert.throws(() => f.plan({ ...f.choice(), resolutions: {} }), /exact resolution/);
});

test("instruction edits invalidate output reviews, target snapshots, and old plan approvals", async (t) => {
  const f = instructionFixture(t); await f.prepare(ROOT_GUIDANCE, { instructionFiles: ROOT_BUNDLE }); f.draft();
  sync.reviewInstructions({ stage: f.stage, note: "Reviewed all target facts and gates." });
  const plan = f.plan(f.choice()); put(f.stage, "instructions/DOCUMENTATION.md", readFileSync(join(f.stage, "instructions/DOCUMENTATION.md"), "utf8") + "\nNew draft wording.\n");
  assert.throws(() => f.plan(f.choice()), /instruction.*review/i);
  sync.reviewInstructions({ stage: f.stage, note: "Reviewed the additional wording." });
  assert.throws(() => applySync({ root: f.root, stage: f.stage, catalog: f.catalog, selection: f.choice(), apply: true, confirm: true, planId: plan.planId }), /stale/);
  put(f.root, "DOCUMENTATION.md", "New local policy after preparation.\n");
  assert.throws(() => f.plan(f.choice()), /Target requirements changed/);
});

test("optional Claude imports preserve existing rules and unselected managed instructions are retained", async (t) => {
  const f = instructionFixture(t); const files = [...ROOT_BUNDLE, "CLAUDE.md"];
  await f.prepare(ROOT_GUIDANCE, { instructionFiles: files }); f.draft(files);
  sync.reviewInstructions({ stage: f.stage, note: "Reviewed optional Claude bridge and preserved custom instructions." }); f.apply(f.choice(files));
  assert.match(readFileSync(join(f.root, "CLAUDE.md"), "utf8"), /^@AGENTS.md\n/);
  assert.match(readFileSync(join(f.root, "CLAUDE.md"), "utf8"), /Existing Claude instructions/);
  const old = readFileSync(join(f.root, "AGENTS.md"), "utf8");
  await f.prepare([], { stage: join(f.base, "skills-only-stage") });
  f.apply(f.selection([]), { stage: join(f.base, "skills-only-stage") });
  assert.equal(readFileSync(join(f.root, "AGENTS.md"), "utf8"), old);
  assert.equal(sync.projectStatus(f.root).files.find((p) => p.path === "AGENTS.md").state, "clean");
});

test("instruction evidence changes stop a plan without reading credential files", async (t) => {
  const f = instructionFixture(t); await f.prepare(ROOT_GUIDANCE, { instructionFiles: ROOT_BUNDLE }); f.draft();
  sync.reviewInstructions({ stage: f.stage, note: "Reviewed current project evidence." });
  put(f.root, "package.json", JSON.stringify({ scripts: { check: "a new project check" } }));
  assert.throws(() => f.plan(f.choice()), /Instruction evidence changed/);
  assert.throws(() => sync.reviewInstructions({ stage: f.stage, note: "Attempted credential evidence.", evidence: [".env"] }), /credential files/);
  assert.throws(() => sync.reviewInstructions({ stage: f.stage, note: "Unsafe evidence key.", evidence: ["__proto__"] }), /Unsafe instruction evidence key/);
  put(f.root, "policy/commands.md", "An approved custom check.\n");
  sync.reviewInstructions({ stage: f.stage, note: "Reviewed the new manifest and explicit command evidence.", evidence: ["policy/commands.md"] });
  f.plan(f.choice());
  put(f.root, "policy/commands.md", "Changed the custom check.\n");
  assert.throws(() => f.plan(f.choice()), /Instruction evidence changed/);
});

test("instruction drafts identify one project and are bound to their actual target", async (t) => {
  const f = instructionFixture(t); await f.prepare(ROOT_GUIDANCE, { instructionFiles: ROOT_BUNDLE }); f.draft();
  const path = join(f.stage, "instructions/CONTRIBUTING.md"); const valid = readFileSync(path, "utf8");
  writeFileSync(path, valid.replace("Fixture project", "Another project"));
  assert.throws(() => sync.reviewInstructions({ stage: f.stage, note: "Conflicting project identities." }), /project name/i);
  writeFileSync(path, valid); sync.reviewInstructions({ stage: f.stage, note: "Reviewed one project identity." });
  assert.throws(() => f.plan(f.choice(), { root: f.primary }), /instruction stage.*target/i);
});

test("legacy version-2 root records remain historical until explicit bundle adoption", async (t) => {
  const f = instructionFixture(t); const before = readFileSync(join(f.root, "AGENTS.md"), "utf8");
  put(f.root, LOCK_PATH, JSON.stringify({ schemaVersion: 2, skills: {}, selection: {}, files: { "AGENTS.md": { kind: "instruction", sourcePath: "AGENTS.md", sourceSha256: digest(before), installedSha256: digest(before) } } }));
  await f.prepare(["alpha"]); f.apply(f.selection(["alpha"]));
  let lock = JSON.parse(readFileSync(join(f.root, LOCK_PATH), "utf8"));
  assert.equal(lock.schemaVersion, 3); assert.ok(lock.legacyInstructions["AGENTS.md"]); assert.equal(lock.files["AGENTS.md"], undefined);
  assert.equal(readFileSync(join(f.root, "AGENTS.md"), "utf8"), before);
  const stage = join(f.base, "adopt-instructions"); await f.prepare(ROOT_GUIDANCE, { stage, instructionFiles: ROOT_BUNDLE }); f.draft(ROOT_BUNDLE, stage);
  sync.reviewInstructions({ stage, note: "Owner selected and reviewed explicit adoption after migration." }); f.apply(f.choice(), { stage });
  lock = JSON.parse(readFileSync(join(f.root, LOCK_PATH), "utf8")); assert.equal(lock.files["AGENTS.md"].kind, "instruction"); assert.equal(lock.legacyInstructions["AGENTS.md"], undefined);
});

test("fixed instruction rules cannot be hidden inside code fences", async (t) => {
  const f = instructionFixture(t); await f.prepare(ROOT_GUIDANCE, { instructionFiles: ROOT_BUNDLE }); f.draft();
  const path = join(f.stage, "instructions/AGENTS.md"); writeFileSync(path, "```markdown\n" + readFileSync(path, "utf8") + "\n```\n");
  assert.throws(() => sync.reviewInstructions({ stage: f.stage, note: "Rules hidden as example text." }), /template rule/);
});

test("changing selected guidance invalidates the instruction review even after a skill review", async (t) => {
  const f = instructionFixture(t); await f.prepare(ROOT_GUIDANCE, { instructionFiles: ROOT_BUNDLE }); f.draft();
  sync.reviewInstructions({ stage: f.stage, note: "Reviewed instructions against the chosen guidance." });
  put(f.stage, "skills/document-project/SKILL.md", skill("document-project", "Revised guidance after the instruction review."));
  reviewSkill({ stage: f.stage, name: "document-project", note: "Reviewed the changed skill package." });
  assert.throws(() => f.plan(f.choice()), /instruction.*guidance.*review/i);
  sync.reviewInstructions({ stage: f.stage, note: "Rechecked all instructions against the updated guidance." });
  f.plan(f.choice());
});

test("instruction source acquisition uses the catalog commit and rejects unsafe template entries", async (t) => {
  const f = instructionFixture(t); const revision = "e".repeat(40); const calls = [];
  for (const name of ROOT_GUIDANCE) put(f.root, `.agents/skills/${name}/SKILL.md`, skill(name));
  const paths = ["README.md", ...ROOT_BUNDLE.map((p) => p.replace(".md", ".template.md"))];
  let unsafe = false;
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: revision }));
    if (url.endsWith("/assets/skill-catalog.yaml")) return new Response(readFileSync(f.catalogPath, "utf8"));
    if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: paths.map((name) => ({ path: "templates/" + name, type: "blob", mode: unsafe && name === "AGENTS.template.md" ? "120000" : "100644" })) }));
    assert.ok(url.includes("/" + revision + "/templates/"));
    return new Response(readFileSync(join(f.source, "templates", url.split("/").at(-1))));
  };
  const snapshot = await refreshCatalog({ catalog: f.catalog, directory: join(f.base, "pinned-instruction-catalog"), fetcher });
  const catalog = loadCatalog(snapshot.path);
  await prepareSkills({ root: f.root, catalog, names: [], stage: f.stage, instructionFiles: ROOT_BUNDLE, allowFetch: true, fetcher });
  assert.equal(calls.filter((url) => url.includes("/commits/")).length, 1);
  assert.equal(JSON.parse(readFileSync(join(f.stage, "manifest.json"), "utf8")).instructions.origin.revision, revision);
  unsafe = true;
  await assert.rejects(() => prepareSkills({ root: f.root, catalog, names: [], stage: join(f.base, "unsafe-template-stage"), instructionFiles: ROOT_BUNDLE, allowFetch: true, fetcher }), /unsafe instruction template/);
});

test("instruction writes still reject primary checkouts and unsafe destinations", async (t) => {
  const f = instructionFixture(t);
  await f.prepare(ROOT_GUIDANCE, { root: f.primary, instructionFiles: ROOT_BUNDLE }); f.draft();
  sync.reviewInstructions({ stage: f.stage, note: "Reviewed a primary-checkout plan without authorizing mutation." });
  const plan = f.plan(f.choice(), { root: f.primary });
  assert.throws(() => applySync({ root: f.primary, stage: f.stage, catalog: f.catalog, selection: f.choice(), apply: true, confirm: true, planId: plan.planId }), /primary checkout/);
  assert.equal(existsSync(join(f.primary, "DOCUMENTATION.md")), false);
});

test("optional retained instructions keep their original template provenance", async (t) => {
  const f = instructionFixture(t); const files = [...ROOT_BUNDLE, "CLAUDE.md"];
  await f.prepare(ROOT_GUIDANCE, { instructionFiles: files }); f.draft(files); sync.reviewInstructions({ stage: f.stage, note: "Reviewed the complete optional bridge." }); f.apply(f.choice(files));
  const old = JSON.parse(readFileSync(join(f.root, LOCK_PATH), "utf8")).files["CLAUDE.md"].origin.revision;
  put(f.source, "templates/README.md", readFileSync(join(f.source, "templates/README.md"), "utf8") + "\nReviewed next source revision.\n"); commit(f.source);
  const stage = join(f.base, "next-instruction-source"); await f.prepare(ROOT_GUIDANCE, { stage, instructionFiles: ROOT_BUNDLE }); f.draft(ROOT_BUNDLE, stage);
  sync.reviewInstructions({ stage, note: "Reviewed the next source while retaining the Claude bridge." }); f.apply(f.choice(), { stage });
  const lock = JSON.parse(readFileSync(join(f.root, LOCK_PATH), "utf8"));
  assert.equal(lock.files["CLAUDE.md"].origin.revision, old); assert.notEqual(lock.instructions.origin.revision, old);
  assert.equal(lock.files["CLAUDE.md"].retained, true);
});

test("CLI prepares, reviews, plans, and applies a selected instruction bundle", (t) => {
  const f = instructionFixture(t);
  const cli = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  let result = cli(["prepare", "--root", f.root, "--source-root", f.source, "--catalog", f.catalogPath, "--skills", ROOT_GUIDANCE.join(","), "--stage", f.stage, "--instructions"]);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).instructionReviewRequired, true);
  f.draft(); const evidence = join(f.base, "evidence.json"); writeFileSync(evidence, JSON.stringify(["README.md"]));
  result = cli(["review-instructions", "--stage", f.stage, "--note", "Reviewed evidence, decisions, fixed policy, and custom rules.", "--evidence", evidence]); assert.equal(result.status, 0, result.stderr);
  const choice = join(f.base, "instruction-selection.json"); writeFileSync(choice, JSON.stringify(f.choice()));
  const args = ["--root", f.root, "--stage", f.stage, "--catalog", f.catalogPath, "--selection", choice];
  result = cli(["plan", ...args]); assert.equal(result.status, 0, result.stderr); const plan = JSON.parse(result.stdout);
  const rootWrites = plan.actions.filter((a) => ROOT_BUNDLE.includes(a.path));
  assert.equal(rootWrites.at(-1).path, "AGENTS.md"); assert.equal(plan.actions.at(-1).op, "lock");
  result = cli(["apply", ...args, "--apply", "--confirm", "--plan-id", plan.planId]); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).instructionFiles, [...ROOT_BUNDLE].sort());
});

test("CLI reports usage failures and real catalog includes every local skill exactly once", () => {
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /project skills and instruction bundles/);
  for (const args of [["unknown"], ["inspect"], ["catalog", "--wat"], ["catalog", "--catalog", "a", "--catalog", "b"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }); assert.notEqual(result.status, 0);
  }
  const catalog = loadCatalog(join(PACKAGE_ROOT, "assets/skill-catalog.yaml"), repository);
  assert.ok(catalog.skills.length > 0);
  for (const name of ["grilling", "unslop", "wait-what"]) {
    assert.equal(catalog.byName.get(name).kind, "upstream");
    assert.equal(existsSync(join(repository, ".agents/skills", name)), false);
    assert.equal(existsSync(join(repository, ".claude/skills", name)), false);
  }
  for (const name of ["grill-me", "tdd", "code-review", "systematic-debugging"]) {
    assert.equal(catalog.byName.get(name).kind, "adapted");
    assert.ok(existsSync(join(repository, catalog.byName.get(name).source.path, "SKILL.md")));
  }
  for (const name of ["grill-me", "code-review"]) assert.equal(existsSync(join(repository, catalog.byName.get(name).source.path, "agents/openai.yaml")), false);
  assert.equal(existsSync(join(repository, ".agents/skills/sync-agent-assets")), false);
  assert.equal(existsSync(join(repository, ".claude/skills")), false);
  assert.equal(catalog.byName.get("unslop").legal[0].path, "pstack/LICENSE");
  assert.equal(catalog.byName.get("sync-agent-assets"), undefined);
  assert.equal(catalog.byName.get("sync-my-skills").scope, "personal");
  assert.ok(catalog.byName.get("sync-my-skills").install.argv.includes("--global"));
  assert.ok(catalog.skills.every((s) => s.install.argv[0] !== "npx" || s.install.argv[1] === "-y"));
  assert.ok(!catalog.deprecations["coding-with-rules"]);
});
