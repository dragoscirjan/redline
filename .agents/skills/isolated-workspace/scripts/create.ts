#!/usr/bin/env bun

import { existsSync, realpathSync } from "node:fs";
import {
  EXIT,
  WorkspaceError,
  type BaseRevision,
  type OutputFormat,
  type RepositoryContext,
  type Vcs,
  type WorkspaceLayout,
  assertSafeBranch,
  canonicalIfExists,
  command,
  deriveLayout,
  detectRepository,
  emit,
  ensureWorkspaceRoot,
  gitBase,
  handleError,
  jjBase,
  listGitWorktrees,
  listJjBookmarks,
  listJjWorkspaces,
  parseArgs,
  planId as hashPlan,
  requireBun,
  resolveJjRevision,
} from "./lib.ts";

interface CreateOptions {
  vcs: Vcs;
  branch: string;
  base?: string;
  "dry-run": boolean;
  apply: boolean;
  confirm: boolean;
  "plan-id"?: string;
  format: OutputFormat;
  help: boolean;
}

interface PlannedCommand {
  command: "git" | "jj";
  args: string[];
  cwd?: string;
}

interface CreatePlan {
  vcs: Vcs;
  repository: RepositoryContext;
  layout: WorkspaceLayout;
  base: BaseRevision;
  action: "attach" | "create" | "repair-bookmark" | "reuse";
  branchExists?: boolean;
  status: string;
  commands: PlannedCommand[];
}

const HELP = `Usage:
  bun scripts/create.ts --vcs git|jj --branch NAME [--base REVISION] [--dry-run]
  bun scripts/create.ts --vcs git|jj --branch NAME [--base REVISION] --apply --confirm --plan-id ID

Detects the repository containing the current directory, derives its sibling
<repository>--workspaces directory, and creates or reuses the workspace whose
directory is the final component of --branch. The default mode is plan-only.

Options:
  --vcs VCS         Required version-control tool: git or jj
  --branch NAME     Required full Git branch or Jujutsu bookmark name
  --base REVISION   Base ref or revset; detects Git default branch or uses trunk()
  --dry-run         Explicitly select plan-only mode
  --apply           Create or repair the planned workspace
  --confirm         Confirm that the exact plan was approved
  --plan-id ID      Plan ID emitted by the approved plan-mode run
  --format FORMAT   Output format: json or text (default: json)
  --help            Show this help

Exit codes:
  0 success                  2 invalid arguments
  3 state or path conflict   4 missing environment prerequisite
  5 external command failed  6 filesystem or unexpected failure

Examples:
  bun scripts/create.ts --vcs git --branch change/issue-42
  bun scripts/create.ts --vcs git --branch change/issue-42 --apply --confirm --plan-id PLAN_ID
  bun scripts/create.ts --vcs jj --branch change/issue-42 --base main --apply --confirm --plan-id PLAN_ID`;

function gitPlan(options: CreateOptions): CreatePlan {
  const repository = detectRepository("git");
  const layout = deriveLayout(repository.primaryRoot, options.branch);
  const checked = command(repository.primaryRoot, "git", [
    "check-ref-format",
    "--branch",
    options.branch,
  ], { allowFailure: true });
  if (checked.status !== 0) {
    throw new WorkspaceError(`Invalid Git branch name: ${options.branch}`, EXIT.USAGE);
  }
  const base = gitBase(repository.primaryRoot, options.base);
  const worktrees = listGitWorktrees(repository.primaryRoot);
  const expectedPath = canonicalIfExists(layout.workspacePath);
  const atPath = worktrees.find(
    (entry) => canonicalIfExists(entry.worktree) === expectedPath,
  );
  const branchRef = `refs/heads/${options.branch}`;
  const attached = worktrees.find((entry) => entry.branch === branchRef);
  const branchExists = command(repository.primaryRoot, "git", [
    "show-ref",
    "--verify",
    "--quiet",
    branchRef,
  ], { allowFailure: true }).status === 0;

  if (atPath) {
    if (atPath.branch !== branchRef) {
      throw new WorkspaceError(
        `Workspace path is registered to ${atPath.branch ?? "a detached HEAD"}: ${expectedPath}`,
        EXIT.CONFLICT,
      );
    }
    const status = command(expectedPath, "git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).stdout;
    return {
      vcs: "git",
      repository,
      layout,
      base,
      action: "reuse",
      branchExists: true,
      status: status === "" ? "clean" : "has-changes",
      commands: [],
    };
  }
  if (attached) {
    throw new WorkspaceError(
      `Branch is already attached to another worktree: ${attached.worktree}`,
      EXIT.CONFLICT,
    );
  }
  if (existsSync(layout.workspacePath)) {
    throw new WorkspaceError(
      `Derived workspace path exists but is not the requested worktree: ${layout.workspacePath}`,
      EXIT.CONFLICT,
    );
  }

  const args = branchExists
    ? ["worktree", "add", layout.workspacePath, options.branch]
    : ["worktree", "add", layout.workspacePath, "-b", options.branch, base.commit];
  return {
    vcs: "git",
    repository,
    layout,
    base,
    action: branchExists ? "attach" : "create",
    branchExists,
    status: "not-created",
    commands: [{ command: "git", args, cwd: repository.primaryRoot }],
  };
}

function jjBookmarkTarget(repository: string, name: string): string {
  return resolveJjRevision(repository, name);
}

function jjDescription(repository: string, revision: string): string {
  return command(repository, "jj", [
    "log",
    "--ignore-working-copy",
    "-r",
    revision,
    "--no-graph",
    "-T",
    "description",
  ]).stdout.trim();
}

function jjPlan(options: CreateOptions): CreatePlan {
  const repository = detectRepository("jj");
  const layout = deriveLayout(repository.primaryRoot, options.branch);
  const base = jjBase(repository.primaryRoot, options.base);
  const workspaces = listJjWorkspaces(repository.primaryRoot);
  const existing = workspaces.find((workspace) => workspace.name === layout.workspaceName);
  const bookmarks = listJjBookmarks(repository.primaryRoot);
  const bookmarkExists = bookmarks.includes(options.branch);

  if (existing) {
    const rootResult = command(repository.primaryRoot, "jj", [
      "workspace",
      "root",
      "--name",
      layout.workspaceName,
      "--ignore-working-copy",
    ], { allowFailure: true });
    if (rootResult.status !== 0) {
      throw new WorkspaceError(
        `Jujutsu workspace registration is stale: ${layout.workspaceName}`,
        EXIT.CONFLICT,
      );
    }
    const registeredPath = canonicalIfExists(rootResult.stdout.trim());
    if (registeredPath !== canonicalIfExists(layout.workspacePath)) {
      throw new WorkspaceError(
        `Workspace name is registered at another path: ${registeredPath}`,
        EXIT.CONFLICT,
      );
    }
    if (bookmarkExists) {
      const target = jjBookmarkTarget(repository.primaryRoot, options.branch);
      if (target !== existing.target) {
        throw new WorkspaceError(
          `Bookmark ${options.branch} does not target workspace ${layout.workspaceName}`,
          EXIT.CONFLICT,
        );
      }
    } else if (jjDescription(repository.primaryRoot, existing.target) !== options.branch) {
      throw new WorkspaceError(
        `Workspace ${layout.workspaceName} has no matching bookmark or description`,
        EXIT.CONFLICT,
      );
    }
    return {
      vcs: "jj",
      repository,
      layout,
      base,
      action: bookmarkExists ? "reuse" : "repair-bookmark",
      status: "registered; inspect with jj status before editing",
      commands: bookmarkExists
        ? []
        : [{ command: "jj", args: ["bookmark", "create", options.branch, "-r", "@"], cwd: registeredPath }],
    };
  }
  if (existsSync(layout.workspacePath)) {
    throw new WorkspaceError(
      `Derived workspace path exists but is not a registered Jujutsu workspace: ${layout.workspacePath}`,
      EXIT.CONFLICT,
    );
  }
  if (bookmarkExists) {
    throw new WorkspaceError(
      `Bookmark already exists without the derived workspace: ${options.branch}`,
      EXIT.CONFLICT,
    );
  }
  return {
    vcs: "jj",
    repository,
    layout,
    base,
    action: "create",
    status: "not-created",
    commands: [
      {
        command: "jj",
        args: [
          "workspace",
          "add",
          "--name",
          layout.workspaceName,
          "-r",
          base.commit,
          layout.workspacePath,
        ],
        cwd: repository.primaryRoot,
      },
      { command: "jj", args: ["describe", "-m", options.branch], cwd: layout.workspacePath },
      {
        command: "jj",
        args: ["bookmark", "create", options.branch, "-r", "@"],
        cwd: layout.workspacePath,
      },
    ],
  };
}

function buildPlan(options: CreateOptions): CreatePlan {
  return options.vcs === "git" ? gitPlan(options) : jjPlan(options);
}

function createPlanId(
  plan: CreatePlan,
  workspaceRootAction: "create-directory" | "reuse-directory",
): string {
  return hashPlan({
    vcs: plan.vcs,
    primaryRoot: plan.repository.primaryRoot,
    layout: plan.layout,
    base: plan.base,
    action: plan.action,
    branchExists: plan.branchExists,
    status: plan.status,
    commands: plan.commands,
    workspaceRootAction,
  });
}

function applyPlan(plan: CreatePlan, options: CreateOptions): void {
  if (plan.action === "reuse") return;
  const current = buildPlan(options);
  if (
    current.action !== plan.action ||
    current.layout.workspacePath !== plan.layout.workspacePath ||
    current.base.commit !== plan.base.commit
  ) {
    throw new WorkspaceError("Workspace state changed after planning; run the plan again", EXIT.CONFLICT);
  }
  ensureWorkspaceRoot(plan.layout);
  for (const step of current.commands) {
    command(step.cwd ?? current.repository.primaryRoot, step.command, step.args);
  }
}

function verify(options: CreateOptions): Record<string, unknown> {
  const verified = buildPlan(options);
  if (verified.action !== "reuse") {
    throw new WorkspaceError("Workspace creation did not reach a reusable state", EXIT.COMMAND);
  }
  const path = realpathSync(verified.layout.workspacePath);
  return {
    vcs: verified.vcs,
    branch: options.branch,
    base: verified.base,
    workspaceName: verified.layout.workspaceName,
    workspaceRoot: verified.layout.workspaceRoot,
    workspacePath: path,
    status: verified.status,
  };
}

async function main() {
  requireBun();
  const options = parseArgs(process.argv.slice(2), {
    vcs: { type: "string", required: true, choices: ["git", "jj"] },
    branch: { type: "string", required: true },
    base: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    confirm: { type: "boolean" },
    "plan-id": { type: "string" },
    format: { type: "string", choices: ["json", "text"], default: "json" },
    help: { type: "boolean" },
  }) as unknown as CreateOptions;
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (options.apply && !options["plan-id"]) {
    throw new WorkspaceError("--apply requires --plan-id from the approved plan", EXIT.USAGE);
  }
  assertSafeBranch(options.branch);
  const plan = buildPlan(options);
  const workspaceRootAction = existsSync(plan.layout.workspaceRoot)
    ? "reuse-directory"
    : "create-directory";
  const approvedPlanId = createPlanId(plan, workspaceRootAction);
  if (options.apply && options["plan-id"] !== approvedPlanId) {
    throw new WorkspaceError("The approved plan ID does not match current state", EXIT.CONFLICT);
  }
  if (options.apply) applyPlan(plan, options);
  const result = options.apply
    ? {
        ...verify(options),
        action: plan.action,
        commands: plan.commands,
        workspaceRootAction,
      }
    : {
        vcs: plan.vcs,
        branch: options.branch,
        base: plan.base,
        workspaceName: plan.layout.workspaceName,
        workspaceRoot: plan.layout.workspaceRoot,
        workspacePath: plan.layout.workspacePath,
        workspaceRootAction,
        action: plan.action,
        status: plan.status,
        commands: plan.commands,
      };
  emit(
    {
      skill: "isolated-workspace",
      mode: options.apply ? "apply" : "plan",
      repository: {
        currentRoot: plan.repository.currentRoot,
        primaryRoot: plan.repository.primaryRoot,
      },
      workspaceRoot: plan.layout.workspaceRoot,
      planId: approvedPlanId,
      result,
    },
    options.format,
  );
}

main().catch((error) => handleError(error, HELP));
