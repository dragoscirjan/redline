import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

interface CleanupOutput {
  skill: string;
  mode: "apply" | "plan";
  planId: string;
  eligible: CleanupItem[];
  stale: CleanupItem[];
  skipped: CleanupItem[];
  result: null | {
    removed: CleanupItem[];
    retained: CleanupItem[];
    failed: CleanupItem[];
  };
}

function run(executable: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(executable, args, { cwd, encoding: "utf8", shell: false });
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

function create(repository: string, vcs: "git" | "jj", branch: string): string {
  const args = [CREATE, "--vcs", vcs, "--branch", branch];
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

function invoke(repository: string, args: string[], cwd = repository): SpawnSyncReturns<string> {
  return run("bun", [SCRIPT, ...args], cwd);
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
