#!/usr/bin/env bun

import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXIT,
  WorkspaceError,
  type BaseRevision,
  type OutputFormat,
  type RepositoryContext,
  type Vcs,
  canonicalIfExists,
  command,
  deriveLayout,
  detectRepository,
  emit,
  gitBase,
  handleError,
  isContained,
  jjBase,
  listGitWorktrees,
  listJjBookmarks,
  listJjWorkspaces,
  operationStateGit,
  parseArgs,
  planId as hashPlan,
  requireBun,
  resolveJjRevision,
} from "../../isolated-workspace/scripts/lib.ts";

interface CleanupOptions {
  vcs: Vcs;
  base?: string;
  "dry-run": boolean;
  apply: boolean;
  confirm: boolean;
  "plan-id"?: string;
  format: OutputFormat;
  help: boolean;
}

interface CleanupCommand {
  command: "filesystem" | "git" | "jj";
  args: string[];
}

interface CleanupItem {
  name: string;
  path: string;
  branch?: string | null;
  bookmark?: string | null;
  tip?: string | null;
  integratedTip?: string;
  base?: BaseRevision;
  evidence?: string;
  ignored?: string[];
  reason?: string;
  commands?: CleanupCommand[];
  stale?: boolean;
}

interface CleanupPlan {
  vcs: Vcs;
  repository: RepositoryContext;
  workspaceRoot: string;
  base: BaseRevision;
  eligible: CleanupItem[];
  stale: CleanupItem[];
  skipped: CleanupItem[];
  limits: string[];
  operations?: CleanupCommand[];
}

interface ApplyResult {
  removed: CleanupItem[];
  retained: Array<Record<string, string>>;
  failed: Array<Record<string, string>>;
}

interface JjCommitInfo {
  commit: string;
  empty: boolean;
  conflict: boolean;
  parents: string[];
}

const HELP = `Usage:
  bun scripts/cleanup.ts --vcs git|jj [--base REVISION] [--dry-run]
  bun scripts/cleanup.ts --vcs git|jj [--base REVISION] --apply --confirm --plan-id ID

Detects the repository and sibling <repository>--workspaces directory. It plans
removal of clean integrated workspaces and stale registrations. Removal requires
--apply --confirm, the approved --plan-id, and a complete immediate re-audit.
Force options are never used.

Options:
  --vcs VCS         Required version-control tool: git or jj
  --base REVISION   Integration base; detects Git default branch or uses trunk()
  --dry-run         Explicitly select plan-only mode
  --apply           Remove every eligible workspace and safe stale registration
  --confirm         Confirm that the exact cleanup plan was approved
  --plan-id ID      Plan ID emitted by the approved plan-mode run
  --format FORMAT   Output format: json or text (default: json)
  --help            Show this help

Exit codes:
  0 success                  2 invalid arguments
  3 state or safety conflict 4 missing environment prerequisite
  5 external command failed  6 filesystem or unexpected failure

Examples:
  bun scripts/cleanup.ts --vcs git
  bun scripts/cleanup.ts --vcs git --base main --apply --confirm --plan-id PLAN_ID
  bun scripts/cleanup.ts --vcs jj --base main --apply --confirm --plan-id PLAN_ID`;

function insideOrEqual(parent: string, target: string): boolean {
  return parent === target || isContained(parent, target);
}

function gitIntegrated(repository: string, tip: string, base: BaseRevision): boolean {
  return command(repository, "git", [
    "merge-base",
    "--is-ancestor",
    tip,
    base.commit,
  ], { allowFailure: true }).status === 0;
}

function gitCommonDirectory(workspace: string): string {
  const result = command(workspace, "git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return canonicalIfExists(result.stdout.trim());
}

function auditGit(options: CleanupOptions): CleanupPlan {
  const repository = detectRepository("git");
  const workspaceRoot = deriveLayout(repository.primaryRoot, "placeholder").workspaceRoot;
  const base = gitBase(repository.primaryRoot, options.base);
  const currentDirectory = realpathSync(process.cwd());
  const commonDirectory = gitCommonDirectory(repository.primaryRoot);
  const worktrees = listGitWorktrees(repository.primaryRoot);
  const eligible: CleanupItem[] = [];
  const skipped: CleanupItem[] = [];
  const stale: CleanupItem[] = [];
  const outOfScopeStale: CleanupItem[] = [];

  for (const entry of worktrees) {
    const rawPath = resolve(entry.worktree);
    const path = canonicalIfExists(rawPath);
    const name = rawPath.split(/[\\/]/).at(-1) ?? rawPath;
    const inScope = isContained(workspaceRoot, path) || isContained(workspaceRoot, rawPath);
    if (entry.prunable) {
      const record = {
        name,
        path: rawPath,
        branch: typeof entry.branch === "string"
          ? entry.branch.replace(/^refs\/heads\//, "")
          : null,
        tip: typeof entry.HEAD === "string" ? entry.HEAD : null,
        reason: String(entry.prunable),
      };
      if (inScope) stale.push(record);
      else outOfScopeStale.push(record);
      continue;
    }
    if (!inScope) continue;
    if (path === repository.primaryRoot) {
      skipped.push({ name, path, reason: "primary-worktree" });
      continue;
    }
    if (insideOrEqual(path, currentDirectory)) {
      skipped.push({ name, path, reason: "active-process-directory" });
      continue;
    }
    if (entry.locked) {
      skipped.push({ name, path, reason: "locked" });
      continue;
    }
    if (!existsSync(path)) {
      stale.push({ name, path: rawPath, branch: null, tip: entry.HEAD, reason: "missing" });
      continue;
    }
    if (lstatSync(path).isSymbolicLink()) {
      skipped.push({ name, path, reason: "workspace-symlink" });
      continue;
    }
    if (gitCommonDirectory(path) !== commonDirectory) {
      skipped.push({ name, path, reason: "different-repository" });
      continue;
    }
    if (typeof entry.branch !== "string") {
      skipped.push({ name, path, reason: "detached" });
      continue;
    }
    const branch = entry.branch.replace(/^refs\/heads\//, "");
    const status = command(path, "git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).stdout;
    if (status !== "") {
      skipped.push({ name, path, branch, reason: "dirty" });
      continue;
    }
    const operations = operationStateGit(path);
    if (operations.length > 0) {
      skipped.push({ name, path, branch, reason: `operation-active:${operations.join(",")}` });
      continue;
    }
    const head = command(path, "git", ["rev-parse", "HEAD"]).stdout.trim();
    const branchTip = command(repository.primaryRoot, "git", [
      "rev-parse",
      "--verify",
      `${branch}^{commit}`,
    ], { allowFailure: true });
    if (branchTip.status !== 0 || branchTip.stdout.trim() !== head || entry.HEAD !== head) {
      skipped.push({ name, path, branch, reason: "tip-mismatch" });
      continue;
    }
    if (!gitIntegrated(repository.primaryRoot, head, base)) {
      skipped.push({ name, path, branch, tip: head, reason: "not-integrated" });
      continue;
    }
    const ignored = command(path, "git", ["clean", "-ndX"]).stdout.trim().split(/\r?\n/).filter(Boolean);
    eligible.push({
      name,
      path,
      branch,
      tip: head,
      base,
      evidence: `ancestor:${base.expression}`,
      ignored,
      commands: [
        { command: "git", args: ["worktree", "remove", path] },
        { command: "git", args: ["branch", "-d", branch] },
      ],
    });
  }

  const stalePruneSafe = stale.length > 0 && outOfScopeStale.length === 0;
  if (stale.length > 0 && !stalePruneSafe) {
    for (const item of stale) {
      skipped.push({ ...item, reason: "stale-but-global-prune-has-out-of-scope-targets" });
    }
  }
  const safeStale = stalePruneSafe ? stale : [];
  const operations: CleanupCommand[] = eligible.flatMap((item) => item.commands ?? []);
  if (safeStale.length > 0) {
    operations.push({ command: "git", args: ["worktree", "prune", "--expire", "now", "--verbose"] });
    for (const item of safeStale) {
      if (item.branch && item.tip && gitIntegrated(repository.primaryRoot, item.tip, base)) {
        operations.push({ command: "git", args: ["branch", "-d", item.branch] });
      }
    }
  }

  return {
    vcs: "git",
    repository,
    workspaceRoot,
    base,
    eligible,
    stale: safeStale,
    skipped,
    limits: outOfScopeStale.length > 0
      ? [`Git has ${outOfScopeStale.length} out-of-scope stale registration(s); automatic prune is disabled.`]
      : [],
    operations,
  };
}

function jjCommitInfo(repository: string, revision: string): JjCommitInfo {
  const template = 'commit_id ++ "\\0" ++ empty ++ "\\0" ++ conflict ++ "\\0" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\0"';
  const result = command(repository, "jj", [
    "log",
    "--ignore-working-copy",
    "-r",
    revision,
    "--no-graph",
    "-T",
    template,
  ]);
  const [commit, empty, conflict, parents = ""] = result.stdout.split("\0");
  return {
    commit,
    empty: empty === "true",
    conflict: conflict === "true",
    parents: parents.split(",").filter(Boolean),
  };
}

function jjIntegrated(repository: string, commit: string, base: BaseRevision): boolean {
  const result = command(repository, "jj", [
    "log",
    "--ignore-working-copy",
    "-r",
    `${commit} & ::${base.commit}`,
    "--count",
  ], { allowFailure: true });
  return result.status === 0 && Number(result.stdout.trim()) === 1;
}

function jjBookmarkTargets(repository: string): Array<{ name: string; target: string | null; conflict?: true }> {
  const targets: Array<{ name: string; target: string | null; conflict?: true }> = [];
  for (const name of listJjBookmarks(repository)) {
    try {
      targets.push({ name, target: resolveJjRevision(repository, name) });
    } catch {
      targets.push({ name, target: null, conflict: true });
    }
  }
  return targets;
}

function auditJj(options: CleanupOptions): CleanupPlan {
  const repository = detectRepository("jj");
  const workspaceRoot = deriveLayout(repository.primaryRoot, "placeholder").workspaceRoot;
  const base = jjBase(repository.primaryRoot, options.base);
  const currentDirectory = realpathSync(process.cwd());
  const workspaces = listJjWorkspaces(repository.primaryRoot);
  const bookmarks = jjBookmarkTargets(repository.primaryRoot);
  const eligible: CleanupItem[] = [];
  const stale: CleanupItem[] = [];
  const skipped: CleanupItem[] = [];

  for (const workspace of workspaces) {
    if (workspace.name === "default") continue;
    const expectedPath = resolve(workspaceRoot, workspace.name);
    const rootResult = command(repository.primaryRoot, "jj", [
      "workspace",
      "root",
      "--name",
      workspace.name,
      "--ignore-working-copy",
    ], { allowFailure: true });
    if (rootResult.status !== 0) {
      skipped.push({
        name: workspace.name,
        path: expectedPath,
        reason: "workspace-root-unresolved",
      });
      continue;
    }
    const reportedPath = resolve(rootResult.stdout.trim());
    const path = canonicalIfExists(reportedPath);
    if (!isContained(workspaceRoot, path) && !isContained(workspaceRoot, reportedPath)) continue;
    if (path === repository.primaryRoot || insideOrEqual(path, currentDirectory)) {
      skipped.push({ name: workspace.name, path, reason: "primary-or-active-workspace" });
      continue;
    }
    if (!existsSync(reportedPath)) {
      stale.push({
        name: workspace.name,
        path: reportedPath,
        tip: workspace.target,
        commands: [{ command: "jj", args: ["workspace", "forget", workspace.name] }],
      });
      continue;
    }
    if (lstatSync(reportedPath).isSymbolicLink()) {
      skipped.push({ name: workspace.name, path: reportedPath, reason: "workspace-symlink" });
      continue;
    }
    const status = command(path, "jj", ["status"], { allowFailure: true });
    if (status.status !== 0) {
      skipped.push({ name: workspace.name, path, reason: "working-copy-snapshot-failed" });
      continue;
    }
    const info = jjCommitInfo(path, "@");
    if (info.commit !== workspace.target) {
      skipped.push({
        name: workspace.name,
        path,
        tip: info.commit,
        reason: "working-copy-changed-during-audit",
      });
      continue;
    }
    if (info.conflict) {
      skipped.push({ name: workspace.name, path, reason: "conflicted-working-copy" });
      continue;
    }
    let integratedTip = null;
    if (jjIntegrated(repository.primaryRoot, info.commit, base)) {
      integratedTip = info.commit;
    } else if (
      info.empty &&
      info.parents.length > 0 &&
      info.parents.every((parent) => jjIntegrated(repository.primaryRoot, parent, base))
    ) {
      integratedTip = info.parents.length === 1 ? info.parents[0] : info.commit;
    }
    if (!integratedTip) {
      skipped.push({
        name: workspace.name,
        path,
        tip: info.commit,
        reason: "not-integrated",
      });
      continue;
    }
    const matching = bookmarks.filter(
      (bookmark) =>
        !bookmark.conflict &&
        bookmark.name.split("/").at(-1) === workspace.name &&
        (bookmark.target === info.commit || bookmark.target === integratedTip),
    );
    if (matching.length > 1) {
      skipped.push({ name: workspace.name, path, reason: "ambiguous-bookmark-mapping" });
      continue;
    }
    const bookmark = matching[0]?.name ?? null;
    const commands: CleanupCommand[] = [
      { command: "jj", args: ["workspace", "forget", workspace.name] },
    ];
    if (bookmark) commands.push({ command: "jj", args: ["bookmark", "forget", bookmark] });
    commands.push({ command: "filesystem", args: ["remove-directory", path] });
    eligible.push({
      name: workspace.name,
      path,
      bookmark,
      tip: info.commit,
      integratedTip,
      base,
      evidence: `ancestor:${base.expression}`,
      commands,
    });
  }

  return {
    vcs: "jj",
    repository,
    workspaceRoot,
    base,
    eligible,
    stale,
    skipped,
    limits: [],
    operations: [
      ...eligible.flatMap((item) => item.commands ?? []),
      ...stale.flatMap((item) => item.commands ?? []),
    ],
  };
}

function audit(options: CleanupOptions): CleanupPlan {
  return options.vcs === "git" ? auditGit(options) : auditJj(options);
}

function cleanupPlanId(plan: CleanupPlan): string {
  return hashPlan({
    vcs: plan.vcs,
    primaryRoot: plan.repository.primaryRoot,
    workspaceRoot: plan.workspaceRoot,
    base: plan.base,
    eligible: plan.eligible,
    stale: plan.stale,
    skipped: plan.skipped,
    limits: plan.limits,
    operations: plan.operations,
  });
}

function applyGit(plan: CleanupPlan, options: CleanupOptions): ApplyResult {
  const removed: CleanupItem[] = [];
  const retained: Array<Record<string, string>> = [];
  const failed: Array<Record<string, string>> = [];

  for (const candidate of plan.eligible) {
    const fresh = auditGit(options).eligible.find((item) => item.path === candidate.path);
    if (!fresh || fresh.tip !== candidate.tip || fresh.branch !== candidate.branch) {
      failed.push({ name: candidate.name, reason: "state-changed-before-removal" });
      continue;
    }
    const removal = command(plan.repository.primaryRoot, "git", [
      "worktree",
      "remove",
      candidate.path,
    ], { allowFailure: true });
    if (removal.status !== 0) {
      failed.push({ name: candidate.name, reason: "worktree-remove-failed" });
      continue;
    }
    const stillRegistered = listGitWorktrees(plan.repository.primaryRoot)
      .some((item) => canonicalIfExists(item.worktree) === candidate.path);
    if (existsSync(candidate.path) || stillRegistered) {
      failed.push({ name: candidate.name, reason: "worktree-removal-verification-failed" });
      continue;
    }
    removed.push({ name: candidate.name, path: candidate.path });
    if (!candidate.branch) {
      failed.push({ name: candidate.name, reason: "eligible-branch-missing" });
      continue;
    }
    const branch = command(plan.repository.primaryRoot, "git", [
      "branch",
      "-d",
      candidate.branch,
    ], { allowFailure: true });
    if (branch.status !== 0) {
      retained.push({ branch: candidate.branch, reason: "safe-delete-refused" });
      failed.push({ name: candidate.name, reason: "branch-delete-refused" });
    }
  }

  if (plan.stale.length > 0) {
    const fresh = auditGit(options);
    if (fresh.stale.length === plan.stale.length && fresh.stale.every(
      (item, index) =>
        item.path === plan.stale[index].path &&
        item.branch === plan.stale[index].branch &&
        item.tip === plan.stale[index].tip,
    )) {
      const prune = command(plan.repository.primaryRoot, "git", [
        "worktree",
        "prune",
        "--expire",
        "now",
        "--verbose",
      ], { allowFailure: true });
      if (prune.status === 0) {
        const remaining = listGitWorktrees(plan.repository.primaryRoot)
          .map((item) => resolve(item.worktree));
        for (const item of plan.stale) {
          if (remaining.includes(resolve(item.path))) {
            failed.push({ name: item.name, reason: "stale-prune-verification-failed" });
            continue;
          }
          removed.push({ name: item.name, path: item.path, stale: true });
          if (!item.branch || !item.tip || !gitIntegrated(plan.repository.primaryRoot, item.tip, plan.base)) {
            continue;
          }
          const branchTip = command(plan.repository.primaryRoot, "git", [
            "rev-parse",
            "--verify",
            `${item.branch}^{commit}`,
          ], { allowFailure: true });
          if (branchTip.status !== 0 || branchTip.stdout.trim() !== item.tip) {
            retained.push({ branch: item.branch, reason: "tip-changed-after-prune" });
            continue;
          }
          const branch = command(plan.repository.primaryRoot, "git", [
            "branch",
            "-d",
            item.branch,
          ], { allowFailure: true });
          if (branch.status !== 0) {
            retained.push({ branch: item.branch, reason: "safe-delete-refused" });
            failed.push({ name: item.name, reason: "branch-delete-refused" });
          }
        }
      } else {
        failed.push({ name: "stale-registrations", reason: "git-worktree-prune-failed" });
      }
    } else {
      failed.push({ name: "stale-registrations", reason: "state-changed-before-prune" });
    }
  }
  return { removed, retained, failed };
}

function applyJj(plan: CleanupPlan, options: CleanupOptions): ApplyResult {
  const removed: CleanupItem[] = [];
  const retained: Array<Record<string, string>> = [];
  const failed: Array<Record<string, string>> = [];

  for (const candidate of plan.eligible) {
    const fresh = auditJj(options).eligible.find((item) => item.name === candidate.name);
    if (!fresh || fresh.tip !== candidate.tip || fresh.path !== candidate.path) {
      failed.push({ name: candidate.name, reason: "state-changed-before-removal" });
      continue;
    }
    const forget = command(plan.repository.primaryRoot, "jj", [
      "workspace",
      "forget",
      candidate.name,
    ], { allowFailure: true });
    if (forget.status !== 0) {
      failed.push({ name: candidate.name, reason: "workspace-forget-failed" });
      continue;
    }
    if (candidate.bookmark) {
      const bookmark = command(plan.repository.primaryRoot, "jj", [
        "bookmark",
        "forget",
        candidate.bookmark,
      ], { allowFailure: true });
      if (bookmark.status !== 0) {
        retained.push({ bookmark: candidate.bookmark, reason: "bookmark-forget-failed" });
        failed.push({ name: candidate.name, reason: "bookmark-forget-failed" });
        continue;
      }
    }
    try {
      const path = realpathSync(candidate.path);
      if (!isContained(plan.workspaceRoot, path) || lstatSync(path).isSymbolicLink()) {
        throw new Error("unsafe cleanup path");
      }
      rmSync(path, { recursive: true, force: false, maxRetries: 0 });
      const stillRegistered = listJjWorkspaces(plan.repository.primaryRoot)
        .some((workspace) => workspace.name === candidate.name);
      if (existsSync(path) || stillRegistered) {
        failed.push({ name: candidate.name, reason: "workspace-removal-verification-failed" });
        continue;
      }
      removed.push({ name: candidate.name, path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ name: candidate.name, reason: `directory-remove-failed:${message}` });
    }
  }

  for (const candidate of plan.stale) {
    const fresh = auditJj(options).stale.find((item) => item.name === candidate.name);
    if (!fresh || fresh.path !== candidate.path || fresh.tip !== candidate.tip) {
      failed.push({ name: candidate.name, reason: "state-changed-before-stale-forget" });
      continue;
    }
    const forget = command(plan.repository.primaryRoot, "jj", [
      "workspace",
      "forget",
      candidate.name,
    ], { allowFailure: true });
    if (forget.status === 0) {
      const stillRegistered = listJjWorkspaces(plan.repository.primaryRoot)
        .some((workspace) => workspace.name === candidate.name);
      if (stillRegistered) failed.push({ name: candidate.name, reason: "stale-forget-verification-failed" });
      else removed.push({ name: candidate.name, path: candidate.path, stale: true });
    } else failed.push({ name: candidate.name, reason: "stale-workspace-forget-failed" });
  }
  return { removed, retained, failed };
}

async function main() {
  requireBun();
  const options = parseArgs(process.argv.slice(2), {
    vcs: { type: "string", required: true, choices: ["git", "jj"] },
    base: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    confirm: { type: "boolean" },
    "plan-id": { type: "string" },
    format: { type: "string", choices: ["json", "text"], default: "json" },
    help: { type: "boolean" },
  }) as unknown as CleanupOptions;
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (options.apply && !options["plan-id"]) {
    throw new WorkspaceError("--apply requires --plan-id from the approved plan", EXIT.USAGE);
  }
  const plan = audit(options);
  const approvedPlanId = cleanupPlanId(plan);
  if (options.apply && options["plan-id"] !== approvedPlanId) {
    throw new WorkspaceError("The approved plan ID does not match current state", EXIT.CONFLICT);
  }
  let result = null;
  if (options.apply) {
    const fresh = audit(options);
    if (cleanupPlanId(fresh) !== approvedPlanId) {
      throw new WorkspaceError("Cleanup state changed after planning; run the plan again", EXIT.CONFLICT);
    }
    result = options.vcs === "git" ? applyGit(plan, options) : applyJj(plan, options);
  }

  emit(
    {
      skill: "cleanup-workspaces",
      mode: options.apply ? "apply" : "plan",
      vcs: plan.vcs,
      repository: {
        currentRoot: plan.repository.currentRoot,
        primaryRoot: plan.repository.primaryRoot,
      },
      workspaceRoot: plan.workspaceRoot,
      planId: approvedPlanId,
      base: plan.base,
      eligible: plan.eligible,
      stale: plan.stale,
      skipped: plan.skipped,
      limits: plan.limits,
      operations: plan.operations,
      result,
    },
    options.format,
  );
  if ((result?.failed.length ?? 0) > 0) process.exitCode = EXIT.COMMAND;
}

main().catch((error) => handleError(error, HELP));
