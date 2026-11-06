import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "cleanup.ts");
const CREATE = resolve(import.meta.dir, "../../isolated-workspace/scripts/create.ts");
const temporaryPaths: string[] = [];

interface CleanupItem {
  name: string;
  path: string;
  branch?: string;
  bookmark?: string;
  reason?: string;
}

interface CleanupCommand {
  command: "filesystem" | "git" | "jj";
  args: string[];
  cwd?: string;
}

interface CleanupOutput {
  skill: string;
  mode: "apply" | "plan";
  cleanupMode: "ordinary" | "lane";
  target: string | null;
  canonical: null | { name: string; path: string; ref: string; tip: string };
  planId: string;
  operations: CleanupCommand[];
  eligible: CleanupItem[];
  stale: CleanupItem[];
  skipped: CleanupItem[];
  result: null | {
    removed: CleanupItem[];
    retained: CleanupItem[];
    failed: CleanupItem[];
  };
}

function run(
  executable: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    shell: false,
  });
}

function mustRun(executable: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  const result = run(executable, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function temporaryRepository(prefix: string): string {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryPaths.push(repository, `${repository}--workspaces`);
  return repository;
}

function gitRepository(): string {
  const repository = temporaryRepository("workspace-cleanup-git-");
  mustRun("git", ["init", "-q", "-b", "main"], repository);
  mustRun("git", ["config", "user.name", "Workspace Test"], repository);
  mustRun("git", ["config", "user.email", "workspace@example.invalid"], repository);
  writeFileSync(join(repository, "README.md"), "test\n");
  mustRun("git", ["add", "README.md"], repository);
  mustRun("git", ["commit", "-qm", "initial"], repository);
  return repository;
}

function jjRepository(): string {
  const repository = temporaryRepository("workspace-cleanup-jj-");
  mustRun("jj", ["git", "init", "."], repository);
  return repository;
}

function create(
  repository: string,
  vcs: "git" | "jj",
  branch: string,
  base?: string,
): string {
  const args = [CREATE, "--vcs", vcs, "--branch", branch];
  if (base) args.push("--base", base);
  const planned = run("bun", args, repository);
  if (planned.status !== 0) throw new Error(`create plan failed:\n${planned.stdout}${planned.stderr}`);
  const { planId } = JSON.parse(planned.stdout) as { planId: string };
  const result = run("bun", [
    ...args,
    "--apply",
    "--confirm",
    "--plan-id",
    planId,
  ], repository);
  if (result.status !== 0) throw new Error(`create failed:\n${result.stdout}${result.stderr}`);
  return `${repository}--workspaces/${branch.split("/").at(-1)}`;
}

function invoke(
  repository: string,
  args: string[],
  cwd = repository,
  env?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return run("bun", [SCRIPT, ...args], cwd, env);
}

function output(result: SpawnSyncReturns<string>): CleanupOutput {
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as CleanupOutput;
}

function approvedApply(args: string[], plan: CleanupOutput): string[] {
  return [...args, "--apply", "--confirm", "--plan-id", plan.planId];
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("cleanup-workspaces script", () => {
  test("requires explicit VCS, confirmation, and the approved plan ID", () => {
    const repository = gitRepository();
    expect(invoke(repository, []).status).toBe(2);
    expect(invoke(repository, ["--vcs", "git", "--apply"]).status).toBe(2);

    const missingPlan = invoke(repository, ["--vcs", "git", "--apply", "--confirm"]);
    expect(missingPlan.status).toBe(2);
    expect(missingPlan.stderr).toContain("--plan-id");

    const wrongPlan = invoke(repository, [
      "--vcs",
      "git",
      "--apply",
      "--confirm",
      "--plan-id",
      "0".repeat(64),
    ]);
    expect(wrongPlan.status).toBe(3);
    expect(wrongPlan.stderr).toContain("does not match");

    const emptyLane = invoke(repository, [
      "--vcs",
      "git",
      "--lane",
      "",
      "--base",
      "main",
    ]);
    expect(emptyLane.status).toBe(2);
    expect(emptyLane.stderr).toContain("safe workspace name");

    const laneWithoutBase = invoke(repository, ["--vcs", "git", "--lane", "worker-a"]);
    expect(laneWithoutBase.status).toBe(2);
    expect(laneWithoutBase.stderr).toContain("--lane requires --base");

    const laneRefPath = invoke(repository, [
      "--vcs",
      "git",
      "--lane",
      "change/worker-a",
      "--base",
      "main",
    ]);
    expect(laneRefPath.status).toBe(2);
    expect(laneRefPath.stderr).toContain("safe workspace name");
  });

  test("removes a clean merged Git worktree and safely deletes its branch", () => {
    const repository = gitRepository();
    const workspace = create(repository, "git", "change/merged");
    writeFileSync(join(workspace, "feature.txt"), "merged\n");
    mustRun("git", ["add", "feature.txt"], workspace);
    mustRun("git", ["commit", "-qm", "feature"], workspace);
    mustRun("git", ["merge", "--no-ff", "-m", "merge feature", "change/merged"], repository);

    const args = ["--vcs", "git", "--base", "main"];
    const plan = output(invoke(repository, args));
    expect(plan.eligible.map((item) => item.name)).toEqual(["merged"]);
    expect(existsSync(workspace)).toBe(true);

    const applied = output(invoke(repository, approvedApply(args, plan)));
    expect(applied.result?.failed).toEqual([]);
    expect(existsSync(workspace)).toBe(false);
    expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/change/merged"], repository).status)
      .not.toBe(0);
  });

  test("removes exactly one integrated Git lane from the canonical workspace", () => {
    const repository = gitRepository();
    const canonicalRef = "change/-canonical";
    const laneRef = `${canonicalRef}--lane-worker-a`;
    const otherLaneRef = `${canonicalRef}--lane-worker-b`;
    const canonical = create(repository, "git", canonicalRef);
    const lane = create(repository, "git", laneRef, canonicalRef);
    const otherLane = create(repository, "git", otherLaneRef, canonicalRef);
    writeFileSync(join(lane, "feature.txt"), "lane\n");
    mustRun("git", ["add", "feature.txt"], lane);
    mustRun("git", ["commit", "-qm", "lane change"], lane);
    mustRun("git", ["merge", "--ff-only", laneRef], canonical);
    mustRun("git", ["tag", canonicalRef, "main"], repository);
    rmSync(otherLane, { recursive: true, force: true });

    const args = [
      "--vcs",
      "git",
      "--lane",
      "-canonical--lane-worker-a",
      "--base",
      canonicalRef,
    ];
    const plan = output(invoke(repository, args, canonical));
    expect(plan.cleanupMode).toBe("lane");
    expect(plan.target).toBe("-canonical--lane-worker-a");
    expect(plan.canonical).toEqual(expect.objectContaining({
      path: canonical,
      ref: canonicalRef,
    }));
    expect(plan.eligible.map((item) => item.name)).toEqual(["-canonical--lane-worker-a"]);
    expect(plan.skipped).toEqual([]);
    expect(plan.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: "git",
        args: ["branch", "-d", laneRef],
        cwd: canonical,
      }),
    ]));

    const applied = output(invoke(repository, approvedApply(args, plan), canonical));
    expect(applied.result?.failed).toEqual([]);
    expect(existsSync(lane)).toBe(false);
    expect(existsSync(otherLane)).toBe(false);
    expect(mustRun("git", ["worktree", "list", "--porcelain"], repository).stdout)
      .toContain(otherLane);
    expect(run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${laneRef}`], repository).status)
      .not.toBe(0);
    expect(run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${otherLaneRef}`], repository).status)
      .toBe(0);
  });

  test("binds a Git lane plan to the canonical ref tip", () => {
    const repository = gitRepository();
    const canonicalRef = "change/canonical";
    const canonical = create(repository, "git", canonicalRef);
    const lane = create(repository, "git", `${canonicalRef}--lane-worker-a`, canonicalRef);
    const args = [
      "--vcs",
      "git",
      "--lane",
      "canonical--lane-worker-a",
      "--base",
      canonicalRef,
    ];
    const plan = output(invoke(repository, args, canonical));
    expect(plan.eligible.map((item) => item.name)).toEqual(["canonical--lane-worker-a"]);

    writeFileSync(join(canonical, "after-plan.txt"), "advance canonical\n");
    mustRun("git", ["add", "after-plan.txt"], canonical);
    mustRun("git", ["commit", "-qm", "advance canonical"], canonical);

    const result = invoke(repository, approvedApply(args, plan), canonical);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("does not match");
    expect(existsSync(lane)).toBe(true);
  });

  test("rejects an unintegrated Git lane and a non-canonical cleanup caller", () => {
    const repository = gitRepository();
    const canonicalRef = "change/canonical";
    const laneRef = `${canonicalRef}--lane-unintegrated`;
    const canonical = create(repository, "git", canonicalRef);
    const lane = create(repository, "git", laneRef, canonicalRef);
    writeFileSync(join(lane, "feature.txt"), "not integrated\n");
    mustRun("git", ["add", "feature.txt"], lane);
    mustRun("git", ["commit", "-qm", "unintegrated lane"], lane);
    const args = [
      "--vcs",
      "git",
      "--lane",
      "canonical--lane-unintegrated",
      "--base",
      canonicalRef,
    ];

    const plan = output(invoke(repository, args, canonical));
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ name: "canonical--lane-unintegrated", reason: "not-integrated" }),
    ]);
    const protectedApply = invoke(repository, approvedApply(args, plan), canonical);
    expect(protectedApply.status).toBe(3);
    expect(protectedApply.stderr).toContain("not eligible");
    expect(existsSync(lane)).toBe(true);

    const fromPrimary = invoke(repository, args);
    expect(fromPrimary.status).toBe(3);
    expect(fromPrimary.stderr).toContain("canonical sibling workspace");
  });

  test("rejects Git canonical-as-target and sibling-as-fake-canonical lane cleanup", () => {
    const repository = gitRepository();
    const canonicalRef = "change/canonical";
    const laneARef = `${canonicalRef}--lane-worker-a`;
    const laneBRef = `${canonicalRef}--lane-worker-b`;
    create(repository, "git", canonicalRef);
    const laneA = create(repository, "git", laneARef, canonicalRef);
    create(repository, "git", laneBRef, canonicalRef);

    for (const target of ["canonical", "canonical--lane-worker-b"]) {
      const result = invoke(repository, [
        "--vcs",
        "git",
        "--lane",
        target,
        "--base",
        laneARef,
      ], laneA);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("canonical ref, not a temporary lane ref");
    }
  });

  test("protects an exact locked Git lane", () => {
    const repository = gitRepository();
    const canonicalRef = "change/canonical";
    const laneRef = `${canonicalRef}--lane-locked`;
    const canonical = create(repository, "git", canonicalRef);
    const lane = create(repository, "git", laneRef, canonicalRef);
    mustRun("git", ["worktree", "lock", "--reason", "test lock", lane], repository);
    const args = [
      "--vcs",
      "git",
      "--lane",
      "canonical--lane-locked",
      "--base",
      canonicalRef,
    ];

    const plan = output(invoke(repository, args, canonical));
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ name: "canonical--lane-locked", reason: "locked" }),
    ]);
    const result = invoke(repository, approvedApply(args, plan), canonical);
    expect(result.status).toBe(3);
    expect(existsSync(lane)).toBe(true);
  });

  test("rejects apply when cleanup state differs from the approved plan", () => {
    const repository = gitRepository();
    const workspace = create(repository, "git", "change/state-change");
    const args = ["--vcs", "git", "--base", "main"];
    const plan = output(invoke(repository, args));
    expect(plan.eligible.map((item) => item.name)).toEqual(["state-change"]);
    writeFileSync(join(workspace, "after-plan.txt"), "keep\n");

    const result = invoke(repository, approvedApply(args, plan));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("does not match");
    expect(existsSync(workspace)).toBe(true);
  });

  test("renders cleanup apply results in text format", () => {
    const repository = gitRepository();
    create(repository, "git", "change/text-cleanup");
    const args = ["--vcs", "git", "--base", "main"];
    const plan = output(invoke(repository, args));

    const result = invoke(repository, [...approvedApply(args, plan), "--format", "text"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Plan ID:");
    expect(result.stdout).toContain("- removed: text-cleanup");
  });

  test("preserves dirty and unmerged Git worktrees", () => {
    const repository = gitRepository();
    const dirty = create(repository, "git", "change/dirty");
    writeFileSync(join(dirty, "untracked.txt"), "keep\n");
    const unmerged = create(repository, "git", "change/unmerged");
    writeFileSync(join(unmerged, "feature.txt"), "keep\n");
    mustRun("git", ["add", "feature.txt"], unmerged);
    mustRun("git", ["commit", "-qm", "unmerged"], unmerged);

    const plan = output(invoke(repository, ["--vcs", "git", "--base", "main"]));
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "dirty", reason: "dirty" }),
      expect.objectContaining({ name: "unmerged", reason: "not-integrated" }),
    ]));
  });

  test("preserves a locked Git worktree", () => {
    const repository = gitRepository();
    const workspace = create(repository, "git", "change/locked");
    mustRun("git", ["worktree", "lock", "--reason", "test lock", workspace], repository);

    const plan = output(invoke(repository, ["--vcs", "git", "--base", "main"]));
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ name: "locked", reason: "locked" }),
    ]);
  });

  test("prunes an in-scope stale Git registration and merged branch", () => {
    const repository = gitRepository();
    const workspace = create(repository, "git", "change/stale");
    rmSync(workspace, { recursive: true, force: true });

    const args = ["--vcs", "git", "--base", "main"];
    const plan = output(invoke(repository, args));
    expect(plan.stale.map((item) => item.name)).toEqual(["stale"]);

    output(invoke(repository, approvedApply(args, plan)));
    expect(mustRun("git", ["worktree", "list", "--porcelain"], repository).stdout)
      .not.toContain(workspace);
    expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/change/stale"], repository).status)
      .not.toBe(0);
  });

  test("does not run repository-wide Git prune with out-of-scope stale metadata", () => {
    const repository = gitRepository();
    const inScope = create(repository, "git", "change/in-scope-stale");
    const outside = mkdtempSync(join(tmpdir(), "workspace-outside-stale-"));
    temporaryPaths.push(outside);
    mustRun("git", ["worktree", "add", "-q", "-b", "change/outside-stale", outside, "main"], repository);
    rmSync(inScope, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });

    const plan = output(invoke(repository, ["--vcs", "git", "--base", "main"]));
    expect(plan.stale).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({
        name: "in-scope-stale",
        reason: "stale-but-global-prune-has-out-of-scope-targets",
      }),
    ]);
  });

  test("removes a clean integrated Jujutsu workspace and bookmark", () => {
    const repository = jjRepository();
    const workspace = create(repository, "jj", "change/merged");

    const args = ["--vcs", "jj"];
    const plan = output(invoke(repository, args));
    expect(plan.eligible).toEqual([
      expect.objectContaining({ name: "merged", bookmark: "change/merged" }),
    ]);

    const applied = output(invoke(repository, approvedApply(args, plan)));
    expect(applied.result?.failed).toEqual([]);
    expect(existsSync(workspace)).toBe(false);
    expect(mustRun("jj", ["workspace", "list"], repository).stdout).not.toContain("merged:");
    expect(mustRun("jj", ["bookmark", "list", "--all"], repository).stdout)
      .not.toContain("change/merged");
  });

  test("removes exactly one integrated Jujutsu lane from the canonical workspace", () => {
    const repository = jjRepository();
    const canonicalRef = "change/canonical";
    const laneRef = `${canonicalRef}--lane-worker-a`;
    const otherLaneRef = `${canonicalRef}--lane-worker-b`;
    const canonical = create(repository, "jj", canonicalRef);
    const lane = create(repository, "jj", laneRef, canonicalRef);
    const otherLane = create(repository, "jj", otherLaneRef, canonicalRef);

    const args = [
      "--vcs",
      "jj",
      "--lane",
      "canonical--lane-worker-a",
      "--base",
      canonicalRef,
    ];
    const plan = output(invoke(repository, args, canonical));
    expect(plan.cleanupMode).toBe("lane");
    expect(plan.target).toBe("canonical--lane-worker-a");
    expect(plan.canonical).toEqual(expect.objectContaining({
      path: canonical,
      ref: canonicalRef,
    }));
    expect(plan.eligible).toEqual([
      expect.objectContaining({ name: "canonical--lane-worker-a", bookmark: laneRef }),
    ]);

    const applied = output(invoke(repository, approvedApply(args, plan), canonical));
    expect(applied.result?.failed).toEqual([]);
    expect(existsSync(lane)).toBe(false);
    expect(existsSync(otherLane)).toBe(true);
    expect(mustRun("jj", ["workspace", "list"], repository).stdout)
      .not.toContain("canonical--lane-worker-a:");
    expect(mustRun("jj", ["workspace", "list"], repository).stdout)
      .toContain("canonical--lane-worker-b:");
  });

  test("rejects a changed, unintegrated Jujutsu lane", () => {
    const repository = jjRepository();
    const canonicalRef = "change/canonical";
    const canonical = create(repository, "jj", canonicalRef);
    const lane = create(repository, "jj", `${canonicalRef}--lane-changed`, canonicalRef);
    writeFileSync(join(lane, "feature.txt"), "not integrated\n");

    const plan = output(invoke(repository, [
      "--vcs",
      "jj",
      "--lane",
      "canonical--lane-changed",
      "--base",
      canonicalRef,
    ], canonical));
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ name: "canonical--lane-changed" }),
    ]);
    const args = [
      "--vcs",
      "jj",
      "--lane",
      "canonical--lane-changed",
      "--base",
      canonicalRef,
    ];
    const refreshedPlan = output(invoke(repository, args, canonical));
    const protectedApply = invoke(repository, approvedApply(args, refreshedPlan), canonical);
    expect(protectedApply.status).toBe(3);
    expect(protectedApply.stderr).toContain("not eligible");
    expect(existsSync(lane)).toBe(true);
  });

  test("rejects Jujutsu canonical-as-target and sibling-as-fake-canonical lane cleanup", () => {
    const repository = jjRepository();
    const canonicalRef = "change/canonical";
    const laneARef = `${canonicalRef}--lane-worker-a`;
    const laneBRef = `${canonicalRef}--lane-worker-b`;
    create(repository, "jj", canonicalRef);
    const laneA = create(repository, "jj", laneARef, canonicalRef);
    create(repository, "jj", laneBRef, canonicalRef);

    for (const target of ["canonical", "canonical--lane-worker-b"]) {
      const result = invoke(repository, [
        "--vcs",
        "jj",
        "--lane",
        target,
        "--base",
        laneARef,
      ], laneA);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("canonical ref, not a temporary lane ref");
    }
  });

  test("binds a Jujutsu lane plan to the canonical bookmark tip", () => {
    const repository = jjRepository();
    const canonicalRef = "change/canonical";
    const canonical = create(repository, "jj", canonicalRef);
    const lane = create(repository, "jj", `${canonicalRef}--lane-worker-a`, canonicalRef);
    const args = [
      "--vcs",
      "jj",
      "--lane",
      "canonical--lane-worker-a",
      "--base",
      canonicalRef,
    ];
    const plan = output(invoke(repository, args, canonical));
    expect(plan.eligible.map((item) => item.name)).toEqual(["canonical--lane-worker-a"]);

    writeFileSync(join(canonical, "after-plan.txt"), "advance canonical\n");
    mustRun("jj", ["status"], canonical);
    mustRun("jj", ["bookmark", "set", canonicalRef, "-r", "@"], canonical);

    const result = invoke(repository, approvedApply(args, plan), canonical);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("does not match");
    expect(existsSync(lane)).toBe(true);
  });

  test("protects the original Jujutsu lane path after registration is forgotten", () => {
    const repository = jjRepository();
    const canonicalRef = "change/canonical";
    const laneRef = `${canonicalRef}--lane-worker-a`;
    const canonical = create(repository, "jj", canonicalRef);
    const lane = create(repository, "jj", laneRef, canonicalRef);
    const otherLane = create(repository, "jj", `${canonicalRef}--lane-worker-b`, canonicalRef);
    const args = [
      "--vcs",
      "jj",
      "--lane",
      "canonical--lane-worker-a",
      "--base",
      canonicalRef,
    ];
    const plan = output(invoke(repository, args, canonical));
    const shimDirectory = mkdtempSync(join(tmpdir(), "workspace-cleanup-jj-shim-"));
    temporaryPaths.push(shimDirectory);
    const shim = join(shimDirectory, "jj");
    const realJj = Bun.which("jj");
    expect(realJj).not.toBeNull();
    writeFileSync(shim, `#!/bin/sh
"$REAL_JJ" "$@"
status=$?
if [ "$status" -eq 0 ] && [ "$1" = "workspace" ] && [ "$2" = "forget" ] && [ "$3" = "$TARGET_WORKSPACE" ]; then
  rm -rf -- "$TARGET_PATH"
  ln -s -- "$SUBSTITUTE_PATH" "$TARGET_PATH"
fi
exit "$status"
`);
    chmodSync(shim, 0o755);

    const result = invoke(repository, approvedApply(args, plan), canonical, {
      PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
      REAL_JJ: realJj ?? "jj",
      TARGET_PATH: lane,
      TARGET_WORKSPACE: "canonical--lane-worker-a",
      SUBSTITUTE_PATH: otherLane,
    });
    expect(result.status).toBe(5);
    const applied = JSON.parse(result.stdout) as CleanupOutput;
    expect(applied.result?.failed).toEqual([
      expect.objectContaining({
        name: "canonical--lane-worker-a",
        reason: "workspace-path-changed-after-forget",
      }),
    ]);
    expect(existsSync(otherLane)).toBe(true);
    expect(realpathSync(lane)).toBe(realpathSync(otherLane));
    expect(mustRun("jj", ["bookmark", "list", "--all"], repository).stdout).toContain(laneRef);
  });

  test("preserves a changed, unmerged Jujutsu workspace", () => {
    const repository = jjRepository();
    const workspace = create(repository, "jj", "change/unmerged");
    writeFileSync(join(workspace, "feature.txt"), "keep\n");

    const plan = output(invoke(repository, ["--vcs", "jj"]));
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ name: "unmerged" }),
    ]);
    expect(existsSync(workspace)).toBe(true);
  });

  test("preserves a Jujutsu registration whose root cannot be resolved", () => {
    const repository = jjRepository();
    const workspace = create(repository, "jj", "change/stale");
    rmSync(workspace, { recursive: true, force: true });

    const plan = output(invoke(repository, ["--vcs", "jj"]));
    expect(plan.stale).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ name: "stale", reason: "workspace-root-unresolved" }),
    ]);
    expect(mustRun("jj", ["workspace", "list"], repository).stdout).toContain("stale:");
  });

  test("never removes the workspace containing the cleanup process", () => {
    const repository = gitRepository();
    const workspace = create(repository, "git", "change/active");

    const plan = output(invoke(repository, ["--vcs", "git", "--base", "main"], workspace));
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ name: "active", reason: "active-process-directory" }),
    ]);
  });
});
