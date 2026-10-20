import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "create.ts");
const temporaryPaths: string[] = [];

interface ScriptOutput {
  skill: string;
  mode: "apply" | "plan";
  vcs?: "git" | "jj";
  workspaceRoot: string;
  planId: string;
  result: {
    action?: string;
    branch: string;
    vcs: "git" | "jj";
    workspacePath: string;
  };
}

function run(
  executable: string,
  args: string[],
  cwd: string,
): SpawnSyncReturns<string> {
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
  const repository = temporaryRepository("workspace-create-git-");
  mustRun("git", ["init", "-q", "-b", "main"], repository);
  mustRun("git", ["config", "user.name", "Workspace Test"], repository);
  mustRun("git", ["config", "user.email", "workspace@example.invalid"], repository);
  writeFileSync(join(repository, "README.md"), "test\n");
  mustRun("git", ["add", "README.md"], repository);
  mustRun("git", ["commit", "-qm", "initial"], repository);
  return repository;
}

function jjRepository(): string {
  const repository = temporaryRepository("workspace-create-jj-");
  mustRun("jj", ["git", "init", "."], repository);
  return repository;
}

function invoke(repository: string, args: string[]): SpawnSyncReturns<string> {
  return run("bun", [SCRIPT, ...args], repository);
}

function output(result: SpawnSyncReturns<string>): ScriptOutput {
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as ScriptOutput;
}

function approvedApply(args: string[], plan: ScriptOutput): string[] {
  return [...args, "--apply", "--confirm", "--plan-id", plan.planId];
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("isolated-workspace create script", () => {
  test("requires an explicit VCS and confirmation for mutation", () => {
    const repository = gitRepository();
    const missingVcs = invoke(repository, ["--branch", "change/issue-42"]);
    expect(missingVcs.status).toBe(2);
    expect(missingVcs.stderr).toContain("--vcs");

    const unconfirmed = invoke(repository, [
      "--vcs",
      "git",
      "--branch",
      "change/issue-42",
      "--apply",
    ]);
    expect(unconfirmed.status).toBe(2);
    expect(unconfirmed.stderr).toContain("--confirm");

    const args = ["--vcs", "git", "--branch", "change/issue-42"];
    const plan = output(invoke(repository, args));
    const missingPlan = invoke(repository, [...args, "--apply", "--confirm"]);
    expect(missingPlan.status).toBe(2);
    expect(missingPlan.stderr).toContain("--plan-id");

    const wrongPlan = invoke(repository, [
      ...args,
      "--apply",
      "--confirm",
      "--plan-id",
      "0".repeat(64),
    ]);
    expect(wrongPlan.status).toBe(3);
    expect(wrongPlan.stderr).toContain("does not match");
    expect(existsSync(plan.result.workspacePath)).toBe(false);
  });

  test("plans, creates, and reuses a Git worktree", () => {
    const repository = gitRepository();
    const workspace = `${repository}--workspaces/issue-42`;
    const args = ["--vcs", "git", "--branch", "change/issue-42"];

    const plan = output(invoke(repository, args));
    expect(plan.mode).toBe("plan");
    expect(plan.result.action).toBe("create");
    expect(plan.result.workspacePath).toBe(workspace);
    expect(existsSync(workspace)).toBe(false);

    const applied = output(invoke(repository, approvedApply(args, plan)));
    expect(applied.mode).toBe("apply");
    expect(existsSync(workspace)).toBe(true);

    const reused = output(invoke(repository, args));
    expect(reused.result.action).toBe("reuse");
    expect(mustRun("git", ["branch", "--show-current"], workspace).stdout.trim())
      .toBe("change/issue-42");
  });

  test("rejects apply when repository state differs from the approved plan", () => {
    const repository = gitRepository();
    const args = ["--vcs", "git", "--branch", "change/state-change"];
    const plan = output(invoke(repository, args));
    writeFileSync(join(repository, "after-plan.txt"), "changed\n");
    mustRun("git", ["add", "after-plan.txt"], repository);
    mustRun("git", ["commit", "-qm", "advance base"], repository);

    const result = invoke(repository, approvedApply(args, plan));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("does not match");
    expect(existsSync(plan.result.workspacePath)).toBe(false);
  });

  test("attaches an existing Git branch that is not checked out elsewhere", () => {
    const repository = gitRepository();
    mustRun("git", ["branch", "change/existing", "main"], repository);
    const args = ["--vcs", "git", "--branch", "change/existing"];

    const plan = output(invoke(repository, args));
    expect(plan.result.action).toBe("attach");
    output(invoke(repository, approvedApply(args, plan)));
    expect(mustRun("git", ["branch", "--show-current"], plan.result.workspacePath).stdout.trim())
      .toBe("change/existing");
  });

  test("rejects path collisions and unsafe branch paths", () => {
    const repository = gitRepository();
    const root = `${repository}--workspaces`;
    mkdirSync(join(root, "issue-42"), { recursive: true });

    const collision = invoke(repository, [
      "--vcs",
      "git",
      "--branch",
      "change/issue-42",
    ]);
    expect(collision.status).toBe(3);
    expect(collision.stderr).toContain("exists");

    const traversal = invoke(repository, [
      "--vcs",
      "git",
      "--branch",
      "change/../escape",
    ]);
    expect(traversal.status).toBe(2);
  });

  test("renders complete text plans", () => {
    const repository = gitRepository();
    const result = invoke(repository, [
      "--vcs",
      "git",
      "--branch",
      "change/text-plan",
      "--format",
      "text",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Plan ID:");
    expect(result.stdout).toContain("Action: create");
    expect(result.stdout).toContain("Branch/bookmark: change/text-plan");
    expect(result.stdout).toContain("Workspace:");
    expect(result.stdout).toContain("- command: git worktree add");
    expect(result.stdout).toContain(`(cwd: ${repository})`);

    const jjRepositoryPath = jjRepository();
    const jjWorkspace = `${jjRepositoryPath}--workspaces/text-plan`;
    const jjResult = invoke(jjRepositoryPath, [
      "--vcs",
      "jj",
      "--branch",
      "change/text-plan",
      "--format",
      "text",
    ]);
    expect(jjResult.status).toBe(0);
    expect(jjResult.stdout).toContain("- command: jj describe -m change/text-plan");
    expect(jjResult.stdout).toContain(`(cwd: ${jjWorkspace})`);
  });

  test("plans, creates, and reuses a Jujutsu workspace and bookmark", () => {
    const repository = jjRepository();
    const workspace = `${repository}--workspaces/issue-42`;
    const args = ["--vcs", "jj", "--branch", "change/issue-42"];

    const plan = output(invoke(repository, args));
    expect(plan.result.vcs).toBe("jj");
    expect(plan.result.action).toBe("create");
    expect(existsSync(workspace)).toBe(false);

    output(invoke(repository, approvedApply(args, plan)));
    expect(existsSync(workspace)).toBe(true);

    const reused = output(invoke(repository, args));
    expect(reused.result.action).toBe("reuse");
    expect(mustRun("jj", ["bookmark", "list", "change/issue-42"], repository).stdout)
      .toContain("change/issue-42");

    mustRun("jj", ["bookmark", "forget", "change/issue-42"], repository);
    const repair = output(invoke(repository, args));
    expect(repair.result.action).toBe("repair-bookmark");
    output(invoke(repository, approvedApply(args, repair)));
    expect(mustRun("jj", ["bookmark", "list", "change/issue-42"], repository).stdout)
      .toContain("change/issue-42");
  });

  test("does not repurpose an unrelated Jujutsu workspace with the same leaf name", () => {
    const repository = jjRepository();
    const root = `${repository}--workspaces`;
    const workspace = join(root, "collision");
    mkdirSync(root);
    mustRun("jj", [
      "workspace",
      "add",
      "--name",
      "collision",
      "-r",
      "trunk()",
      workspace,
    ], repository);

    const result = invoke(repository, [
      "--vcs",
      "jj",
      "--branch",
      "change/collision",
    ]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("no matching bookmark or description");
  });

  test("does not treat a secondary Jujutsu workspace as the default root", () => {
    const repository = jjRepository();
    const root = `${repository}--workspaces`;
    const secondary = join(root, "secondary");
    mkdirSync(root);
    mustRun("jj", [
      "workspace",
      "add",
      "--name",
      "secondary",
      "-r",
      "trunk()",
      secondary,
    ], repository);
    mustRun("jj", ["workspace", "forget", "default"], secondary);

    const result = invoke(secondary, [
      "--vcs",
      "jj",
      "--branch",
      "change/unsafe-root",
    ]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("default workspace root");
  });

  test("honors explicit VCS selection in a colocated repository", () => {
    const repository = gitRepository();
    mustRun("jj", ["git", "init", "--colocate", "."], repository);

    const gitPlan = output(invoke(repository, [
      "--vcs",
      "git",
      "--branch",
      "change/git-choice",
    ]));
    const jjPlan = output(invoke(repository, [
      "--vcs",
      "jj",
      "--branch",
      "change/jj-choice",
    ]));

    expect(gitPlan.result.vcs).toBe("git");
    expect(jjPlan.result.vcs).toBe("jj");
  });
});
