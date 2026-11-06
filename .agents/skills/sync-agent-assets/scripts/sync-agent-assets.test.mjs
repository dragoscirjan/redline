import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const script = join(directory, "sync-agent-assets.mjs");
const repositoryRoot = resolve(directory, "../../../..");

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function initializeGit(root) {
  execFileSync("git", ["init", "-q", root]);
  git(root, ["config", "user.name", "Sync Test"]);
  git(root, ["config", "user.email", "sync-test@example.invalid"]);
}

function commitAll(root, message = "fixture") {
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  initializeGit(root);
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  commitAll(root);
  return root;
}

function run(args, cwd = repositoryRoot) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function writeSkill(root, name, body = `# ${name}\n`) {
  const skillRoot = join(root, ".agents", "skills", name);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n${body}`,
  );
}

function syntheticSource() {
  const root = mkdtempSync(join(tmpdir(), "sync-agent-assets-source-"));
  initializeGit(root);
  writeFileSync(join(root, "AGENTS.md"), "# Source agents\n");
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
  writeFileSync(join(root, "CONTRIBUTING.md"), "# Source contributing\n");
  writeFileSync(join(root, "VALIDATION.md"), "# Source validation\n");
  writeSkill(root, "grilling");
  writeFileSync(join(root, ".agents", "skills", "grilling", "notes.md"), "# Grilling notes\n");
  writeSkill(root, "grill-me");
  writeSkill(root, "optional-skill");
  writeSkill(root, "sync-agent-assets");
  const catalog = {
    schemaVersion: 1,
    repository: "fixture/source",
    profiles: {
      manager: ["sync-agent-assets"],
      bootstrap: ["grilling", "grill-me"],
      coreInstructions: [],
    },
    skills: [
      {
        name: "grilling",
        category: "interview",
        selection: "bootstrap",
        dependencies: [],
        safety: "read-only-guidance",
        harnesses: ["pi", "opencode", "claude-code"],
        signals: {},
      },
      {
        name: "grill-me",
        category: "interview-wrapper",
        selection: "bootstrap",
        dependencies: ["grilling"],
        safety: "read-only-guidance",
        harnesses: ["pi", "opencode", "claude-code"],
        signals: {},
      },
      {
        name: "optional-skill",
        category: "utility",
        selection: "optional",
        dependencies: [],
        safety: "read-only-guidance",
        harnesses: ["pi", "opencode", "claude-code"],
        signals: { askWithoutSignals: true },
      },
      {
        name: "sync-agent-assets",
        category: "asset-manager",
        selection: "manager",
        dependencies: ["grill-me"],
        safety: "project-write-with-confirmation",
        harnesses: ["pi", "opencode", "claude-code"],
        signals: {},
      },
    ],
  };
  const catalogPath = join(root, ".agents", "skills", "sync-agent-assets", "assets");
  mkdirSync(catalogPath, { recursive: true });
  writeFileSync(join(catalogPath, "skill-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  const commit = commitAll(root, "source fixture");
  return { root, commit };
}

function installSyntheticAssets(source, target, { claudeProjections = true } = {}) {
  mkdirSync(join(target, ".agents", "skills"), { recursive: true });
  for (const name of ["grilling", "grill-me", "sync-agent-assets"]) {
    cpSync(join(source, ".agents", "skills", name), join(target, ".agents", "skills", name), { recursive: true });
  }
  if (claudeProjections) {
    mkdirSync(join(target, ".claude", "skills"), { recursive: true });
    for (const name of ["grilling", "grill-me", "sync-agent-assets"]) {
      symlinkSync(`../../.agents/skills/${name}`, join(target, ".claude", "skills", name), "dir");
    }
  }
  writeFileSync(join(target, "AGENTS.md"), "# Adapted agents\n");
  writeFileSync(join(target, "CLAUDE.md"), "@AGENTS.md\n");
  writeFileSync(join(target, "CONTRIBUTING.md"), "# Adapted contributing\n");
  writeFileSync(join(target, "VALIDATION.md"), "# Adapted validation\n");
}

function selectionFile(root) {
  const path = join(root, "selection.json");
  writeFileSync(
    path,
    `${JSON.stringify({
      selectedSkills: [],
      declinedSkills: [{ name: "optional-skill", reason: "Not applicable." }],
      rootFiles: ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "VALIDATION.md"],
      adaptations: { "AGENTS.md": "Preserved fixture rules." },
    }, null, 2)}\n`,
  );
  return path;
}

test("help documents prerequisites and approval-bound recording", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Node\.js 22\.20 or newer/);
  assert.match(result.stdout, /--apply --confirm --plan-id/);
  assert.match(result.stdout, /never edits project assets/i);
});

test("documentation pins the Skills CLI and resolves helper commands from the skill directory", () => {
  const files = [
    join(repositoryRoot, "AGENTS.md"),
    join(repositoryRoot, "README.md"),
    join(repositoryRoot, ".agents", "skills", "sync-agent-assets", "SKILL.md"),
  ];
  const contents = files.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(contents, /npx(?: --yes)? skills(?:\s|$)/);
  assert.doesNotMatch(contents, /skills@1\.7\.4 use[^\n]*--agent (?:pi|opencode)/);
  assert.equal(contents.match(/skills@1\.7\.4/g)?.length, 8);
  assert.match(contents, /Skills CLI 1\.7\.4 cannot launch Pi or OpenCode/);
  assert.match(contents, /pi "\$SYNC_AGENT_PROMPT/);
  assert.match(contents, /opencode --prompt "\$SYNC_AGENT_PROMPT/);
  assert.match(contents, /skills@1\.7\.4 use dragoscirjan\/ai@sync-agent-assets --agent claude-code/);
  assert.match(contents, /--agent pi[\s\S]*--agent opencode[\s\S]*--agent claude-code/);
  assert.doesNotMatch(contents, /--agent claude-code \\\n\s+--copy/);
  const skill = readFileSync(files[2], "utf8");
  assert.doesNotMatch(skill, /node scripts\/sync-agent-assets\.mjs/);
  assert.match(skill, /node "\$SYNC_AGENT_ASSETS_HELPER"/);
  assert.match(skill, /\/skill:grill-me/);
  assert.match(skill, /follow `grilling` directly/);
});

test("Skills CLI generates a temporary prompt with supporting files without launching an agent", { timeout: 120_000 }, () => {
  let tempRoot;
  try {
    const result = spawnSync("npx", [
      "--yes",
      "skills@1.7.4",
      "use",
      repositoryRoot,
      "--skill",
      "sync-agent-assets",
    ], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Running (?:Pi|OpenCode) is not supported/);
    const supportMatch = result.stdout.match(/Supporting files for this skill were downloaded to:\n([^\n]+)/);
    assert.ok(supportMatch, "generated prompt must identify its supporting-files directory");
    const skillRoot = supportMatch[1].trim();
    tempRoot = dirname(skillRoot);
    assert.match(basename(tempRoot), /^skills-use-/);
    assert.equal(existsSync(join(skillRoot, "scripts", "sync-agent-assets.mjs")), true);
    assert.equal(existsSync(join(skillRoot, "references", "data-model.md")), true);
  } finally {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Skills CLI launches the Claude Code bootstrap with temporary supporting files", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "sync-agent-assets-claude-use-"));
  try {
    const bin = join(root, "bin");
    const capture = join(root, "capture.json");
    mkdirSync(bin);
    const fakeClaude = join(bin, "claude");
    writeFileSync(fakeClaude, `#!/usr/bin/env node\nconst fs=require("node:fs");\nconst prompt=process.argv[2]??"";\nconst match=prompt.match(/Supporting files for this skill were downloaded to:\\n([^\\n]+)/);\nconst skillRoot=match?.[1]?.trim();\nconst valid=Boolean(skillRoot&&fs.existsSync(skillRoot+"/scripts/sync-agent-assets.mjs")&&fs.existsSync(skillRoot+"/references/data-model.md"));\nfs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({prompt,skillRoot,valid}));\nprocess.exit(valid?0:1);\n`);
    chmodSync(fakeClaude, 0o755);
    const result = spawnSync("npx", [
      "--yes",
      "skills@1.7.4",
      "use",
      repositoryRoot,
      "--skill",
      "sync-agent-assets",
      "--agent",
      "claude-code",
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const launched = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(launched.valid, true);
    assert.match(launched.prompt, /sync-agent-assets/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight verifies required local runtimes", () => {
  const result = run(["preflight"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.node, /^\d+\.\d+\.\d+/);
  assert.match(output.npx, /^\d+\.\d+\.\d+/);
  assert.match(output.git, /^git version /);
  assert.match(output.bun, /^\d+\.\d+\.\d+/);
  assert.equal(output.network, "verified by fetch");
});

test("the catalog covers every repository skill directory", () => {
  for (const name of ["skill-catalog.schema.json", "selection.schema.json", "ai-assets-lock.schema.json"]) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(repositoryRoot, ".agents", "skills", "sync-agent-assets", "assets", name), "utf8")));
  }
  const result = run(["catalog", "--source-root", repositoryRoot]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const names = new Set(output.skills.map((entry) => entry.name));
  assert.equal(names.has("sync-agent-assets"), true);
  assert.equal(names.has("coding-tsx"), true);
  assert.equal(names.has("instruction-maintenance"), true);
  assert.equal(output.skills.every((entry) => entry.harnesses.includes("claude-code")), true);
  assert.equal(readFileSync(join(repositoryRoot, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  for (const entry of output.skills) {
    assert.equal(
      readlinkSync(join(repositoryRoot, ".claude", "skills", entry.name)),
      `../../.agents/skills/${entry.name}`,
    );
  }
});

test("inspect detects mode, language skills, wrappers, and ambiguous initializers", () => {
  const root = fixture("sync-agent-assets-inspect-");
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.tsx"), "export const App = () => null;\n");
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    commitAll(root, "add typescript");
    const result = run(["inspect", "--root", root]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, "init");
    const recommended = new Set(output.recommendedClosure);
    assert.equal(recommended.has("sync-agent-assets"), true);
    assert.equal(recommended.has("grill-me"), true);
    assert.equal(recommended.has("coding"), true);
    assert.equal(recommended.has("coding-ts"), true);
    assert.equal(recommended.has("coding-tsx"), true);
    const ambiguous = new Set(output.ambiguousSkills.map((entry) => entry.name));
    assert.equal(ambiguous.has("init-typescript"), true);
    assert.equal(ambiguous.has("init-project"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspect disables repository-configured Git fsmonitor commands", () => {
  const root = fixture("sync-agent-assets-fsmonitor-");
  const marker = join(tmpdir(), `sync-agent-assets-fsmonitor-${process.pid}-${Date.now()}`);
  try {
    const hook = join(root, ".git", "fsmonitor-test.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '\\n'\n`);
    chmodSync(hook, 0o755);
    git(root, ["config", "core.fsmonitor", hook]);
    git(root, ["status", "--porcelain=v1"]);
    assert.equal(existsSync(marker), true, "test fixture must execute the configured fsmonitor command");
    rmSync(marker, { force: true });

    const result = run(["inspect", "--root", root]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(marker, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("record plans, requires confirmation, writes a portable lock, and detects local edits", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-target-");
  try {
    installSyntheticAssets(source.root, target);
    const selection = selectionFile(target);
    const plan = run([
      "record",
      "--root", target,
      "--source-root", source.root,
      "--source-commit", source.commit,
      "--selection", selection,
    ]);
    assert.equal(plan.status, 0, plan.stderr);
    const planned = JSON.parse(plan.stdout);
    assert.equal(planned.mode, "plan");
    assert.deepEqual(planned.selectedSkills, ["grill-me", "grilling", "sync-agent-assets"]);
    assert.equal(existsSync(join(target, ".agents", "ai-assets.lock.json")), false);

    const unconfirmed = run([
      "record",
      "--root", target,
      "--source-root", source.root,
      "--source-commit", source.commit,
      "--selection", selection,
      "--apply",
    ]);
    assert.equal(unconfirmed.status, 2);

    const applied = run([
      "record",
      "--root", target,
      "--source-root", source.root,
      "--source-commit", source.commit,
      "--selection", selection,
      "--apply",
      "--confirm",
      "--plan-id", planned.planId,
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const lockText = readFileSync(join(target, ".agents", "ai-assets.lock.json"), "utf8");
    assert.doesNotMatch(lockText, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const lock = JSON.parse(lockText);
    assert.equal(lock.$schema, "./skills/sync-agent-assets/assets/ai-assets-lock.schema.json");
    assert.equal(lock.source.commit, source.commit);
    assert.equal(lock.selection.adaptations["AGENTS.md"], "Preserved fixture rules.");
    assert.equal(Object.keys(lock.projections).length, 3);
    assert.equal(lock.projections[".claude/skills/grilling"].target, "../../.agents/skills/grilling");

    const detectedUpdate = run(["inspect", "--root", target]);
    assert.equal(detectedUpdate.status, 0, detectedUpdate.stderr);
    assert.equal(JSON.parse(detectedUpdate.stdout).mode, "update");

    const clean = run(["status", "--root", target]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(JSON.parse(clean.stdout).counts.modified, 0);

    writeFileSync(join(target, ".agents", "skills", "grilling", "SKILL.md"), "locally changed\n");
    const modified = run(["status", "--root", target]);
    assert.equal(modified.status, 0, modified.stderr);
    assert.equal(JSON.parse(modified.stdout).counts.modified, 1);

    rmSync(join(target, ".agents", "skills", "grilling", "SKILL.md"));
    const missing = run(["status", "--root", target]);
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).counts.missing, 1);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("compare distinguishes clean upstream changes, conflicts, and retained removals", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-compare-");
  try {
    installSyntheticAssets(source.root, target);
    writeFileSync(join(target, ".agents", "skills", "grill-me", "SKILL.md"), "approved local adaptation\n");
    const selection = selectionFile(target);
    const plan = JSON.parse(run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
    ]).stdout);
    assert.equal(run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
      "--apply", "--confirm", "--plan-id", plan.planId,
    ]).status, 0);

    writeFileSync(join(source.root, ".agents", "skills", "grilling", "SKILL.md"), "upstream changed\n");
    writeFileSync(join(source.root, ".agents", "skills", "grill-me", "SKILL.md"), "upstream changed too\n");
    rmSync(join(source.root, "VALIDATION.md"));
    commitAll(source.root, "change source");
    const first = run(["compare", "--root", target, "--source-root", source.root]);
    assert.equal(first.status, 0, first.stderr);
    const states = new Map(JSON.parse(first.stdout).files.map((entry) => [entry.path, entry.state]));
    assert.equal(states.get(".agents/skills/grilling/SKILL.md"), "upstream-changed-clean");
    assert.equal(states.get(".agents/skills/grill-me/SKILL.md"), "conflict");
    assert.equal(states.get("VALIDATION.md"), "upstream-removed-retain");

    writeFileSync(join(target, ".agents", "skills", "grilling", "SKILL.md"), "local changed\n");
    const second = run(["compare", "--root", target, "--source-root", source.root]);
    assert.equal(second.status, 0, second.stderr);
    const conflict = JSON.parse(second.stdout).files.find((entry) => entry.path === ".agents/skills/grilling/SKILL.md");
    assert.equal(conflict.state, "conflict");
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("compare and record reject dirty pinned source checkouts", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-dirty-source-");
  try {
    installSyntheticAssets(source.root, target);
    const selection = selectionFile(target);
    const plan = JSON.parse(run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
    ]).stdout);
    assert.equal(run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
      "--apply", "--confirm", "--plan-id", plan.planId,
    ]).status, 0);

    writeFileSync(join(source.root, "dirty.txt"), "not committed\n");
    const compared = run(["compare", "--root", target, "--source-root", source.root]);
    assert.equal(compared.status, 3);
    assert.match(compared.stderr, /source checkout must be clean/);
    const recorded = run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
    ]);
    assert.equal(recorded.status, 3);
    assert.match(recorded.stderr, /source checkout must be clean/);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("record preserves approved files removed from a selected upstream skill", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-retain-");
  try {
    installSyntheticAssets(source.root, target);
    const selection = selectionFile(target);
    const initialPlan = JSON.parse(run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
    ]).stdout);
    assert.equal(run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
      "--apply", "--confirm", "--plan-id", initialPlan.planId,
    ]).status, 0);

    const retainedPath = ".agents/skills/grilling/notes.md";
    rmSync(join(source.root, retainedPath));
    const nextCommit = commitAll(source.root, "remove support file");
    const updateSelection = JSON.parse(readFileSync(selection, "utf8"));
    updateSelection.retainedFiles = [{ path: retainedPath, reason: "Removal is not approved." }];
    writeFileSync(selection, `${JSON.stringify(updateSelection, null, 2)}\n`);

    const updatePlanResult = run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", nextCommit, "--selection", selection,
    ]);
    assert.equal(updatePlanResult.status, 0, updatePlanResult.stderr);
    const updatePlan = JSON.parse(updatePlanResult.stdout);
    assert.equal(updatePlan.lock.files[retainedPath].retained, true);
    assert.equal(updatePlan.lock.files[retainedPath].retentionReason, "Removal is not approved.");
    const applied = run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", nextCommit, "--selection", selection,
      "--apply", "--confirm", "--plan-id", updatePlan.planId,
    ]);
    assert.equal(applied.status, 0, applied.stderr);

    const compared = run(["compare", "--root", target, "--source-root", source.root]);
    assert.equal(compared.status, 0, compared.stderr);
    const retained = JSON.parse(compared.stdout).files.find((entry) => entry.path === retainedPath);
    assert.equal(retained.state, "upstream-removed-retain");
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("old locks remain readable and report missing Claude Code projections", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-old-lock-");
  try {
    installSyntheticAssets(source.root, target);
    const selection = selectionFile(target);
    const plan = JSON.parse(run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
    ]).stdout);
    assert.equal(run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
      "--apply", "--confirm", "--plan-id", plan.planId,
    ]).status, 0);
    const lockPath = join(target, ".agents", "ai-assets.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    delete lock.projections;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    rmSync(join(target, ".claude"), { recursive: true, force: true });

    const status = run(["status", "--root", target]);
    assert.equal(status.status, 0, status.stderr);
    const output = JSON.parse(status.stdout);
    assert.equal(output.projectionCounts.missing, 3);
    assert.equal(output.projections.every((entry) => entry.state === "missing"), true);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("record rejects missing or conflicting Claude Code projections", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-claude-conflict-");
  try {
    installSyntheticAssets(source.root, target, { claudeProjections: false });
    const missing = run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selectionFile(target),
    ]);
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /Claude Code skill projections/);
    assert.match(missing.stderr, /missing/);

    mkdirSync(join(target, ".claude", "skills", "grilling"), { recursive: true });
    for (const name of ["grill-me", "sync-agent-assets"]) {
      symlinkSync(`../../.agents/skills/${name}`, join(target, ".claude", "skills", name), "dir");
    }
    const conflict = run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selectionFile(target),
    ]);
    assert.equal(conflict.status, 3);
    assert.match(conflict.stderr, /grilling:conflict/);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("Skills CLI installs canonical skills with Claude Code symlink projections", { timeout: 120_000 }, () => {
  const target = fixture("sync-agent-assets-cli-install-");
  try {
    const result = spawnSync("npx", [
      "--yes", "skills@1.7.4", "add", repositoryRoot,
      "--skill", "sync-agent-assets",
      "--agent", "pi",
      "--agent", "opencode",
      "--agent", "claude-code",
      "--yes",
    ], { cwd: target, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    const projection = join(target, ".claude", "skills", "sync-agent-assets");
    assert.equal(readlinkSync(projection), "../../.agents/skills/sync-agent-assets");
    assert.equal(existsSync(join(target, ".agents", "skills", "sync-agent-assets", "scripts", "sync-agent-assets.mjs")), true);
    assert.equal(existsSync(join(target, "skills-lock.json")), true);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("record refuses target skill directories with unmanaged extra files", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-extra-");
  try {
    installSyntheticAssets(source.root, target);
    writeFileSync(join(target, ".agents", "skills", "grilling", "local.txt"), "extra\n");
    const result = run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selectionFile(target),
    ]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /differs structurally/);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("record apply rejects a symbolic-link lock directory", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-lock-symlink-");
  try {
    installSyntheticAssets(source.root, target);
    const selection = selectionFile(target);
    const plan = JSON.parse(run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
    ]).stdout);
    renameSync(join(target, ".agents"), join(target, ".agents-real"));
    symlinkSync(".agents-real", join(target, ".agents"), "dir");

    const result = run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
      "--apply", "--confirm", "--plan-id", plan.planId,
    ]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /path component must not be a symbolic link/);
    assert.equal(existsSync(join(target, ".agents-real", "ai-assets.lock.json")), false);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("record rejects symbolic links inside managed skill directories", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-symlink-");
  try {
    installSyntheticAssets(source.root, target);
    symlinkSync("SKILL.md", join(target, ".agents", "skills", "grilling", "linked.md"));
    const result = run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selectionFile(target),
    ]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /must not contain symbolic links/);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("catalog rejects uncatalogued source skills", () => {
  const source = syntheticSource();
  try {
    writeSkill(source.root, "uncatalogued-skill");
    const result = run(["catalog", "--source-root", source.root]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /Catalog coverage mismatch/);
    assert.match(result.stderr, /uncatalogued-skill/);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test("record rejects credential-like adaptation data", () => {
  const source = syntheticSource();
  const target = fixture("sync-agent-assets-secret-");
  try {
    installSyntheticAssets(source.root, target);
    const selection = selectionFile(target);
    const data = JSON.parse(readFileSync(selection, "utf8"));
    data.adaptations["AGENTS.md"] = "Use github_pat_1234567890abcdefghijklmnop";
    writeFileSync(selection, `${JSON.stringify(data, null, 2)}\n`);
    const result = run([
      "record", "--root", target, "--source-root", source.root,
      "--source-commit", source.commit, "--selection", selection,
    ]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /credential material/);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("cleanup refuses unmarked temporary directories", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "sync-agent-assets-unmarked-"));
  const sourceRoot = join(tempRoot, "source");
  mkdirSync(sourceRoot);
  try {
    const result = run(["cleanup", "--source-root", sourceRoot]);
    assert.equal(result.status, 3);
    assert.equal(existsSync(tempRoot), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("cleanup removes only helper-created temporary source roots", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "sync-agent-assets-cleanup-"));
  const sourceRoot = join(tempRoot, "source");
  writeFileSync(join(tempRoot, ".sync-agent-assets-temp.json"), `${JSON.stringify({ schemaVersion: 1, owner: "sync-agent-assets", source: "source" })}\n`);
  mkdirSync(sourceRoot);
  const result = run(["cleanup", "--source-root", sourceRoot]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(tempRoot), false);
});
