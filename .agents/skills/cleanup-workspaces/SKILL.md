---
name: cleanup-workspaces
description: Audit and remove Redline's finished Git worktrees only when the owner requests cleanup and confirms an exact removal plan. Never infer permission from a merged PR or a clean status.
disable-model-invocation: true
compatibility: Requires Git with worktree support.
metadata:
  author: dragoscirjan
  version: "1.0-redline"
  opencode/slash: "true"
---

# Cleanup workspaces

Start with a read-only audit. Do not remove a worktree, branch, or directory until the owner confirms the complete plan after seeing the evidence. This skill is for Redline's Git worktrees; do not use the ai repository's Jujutsu commands, fixed branch prefix, or memory-derived root.

## Read the workspace policy

Read the nearest `AGENTS.md`, `CONTRIBUTING.md`, and `.agents/skills/isolated-workspace/SKILL.md`. Resolve the configured workspace root, `../redline--workspaces`, from the primary checkout and canonicalize every path. Work from a checkout that will survive the cleanup.

If the owner named worktrees, audit only those. Do not silently add other candidates. Do not fetch, pull, rebase, change branches, or update `main` while auditing. If local base data may be stale, report that limit and stop. The statement that a task was merged is not proof that the exact worktree tip was integrated.

## Exclude unsafe targets

Never remove:

- the primary checkout, the current process directory, or the workspace containing the active agent session;
- a locked, prunable, missing, inaccessible, bare, detached, or unregistered worktree;
- a path outside the canonical workspace root or belonging to another repository;
- a worktree with untracked or unrelated changes, conflicts, or a Git operation in progress;
- a worktree whose branch, issue, task, path, or integration status cannot be confirmed.

Redline does not require a fixed branch prefix. Match each branch and workspace to its tracked issue or task. A similar name alone is not enough.

## Audit registered Git worktrees

Read registered worktrees with machine-readable output:

```sh
git worktree list --porcelain -z
```

For each candidate, compare the canonical path against the workspace root. Require the same Git common directory as the primary checkout. Then inspect without changing state:

```sh
git -C "$workspace_path" status --porcelain=v1 --untracked-files=all
git -C "$workspace_path" symbolic-ref -q HEAD
git -C "$workspace_path" rev-parse HEAD
git rev-parse "$branch_name"
git -C "$workspace_path" clean -ndX
```

Require empty status. Require the recorded branch, symbolic ref, branch tip, and worktree HEAD to agree. Check for merge, rebase, cherry-pick, revert, or bisect state through the candidate's Git paths. Show ignored files from `clean -ndX` in the plan because worktree removal may delete them. Never run `git clean` without `-n`.

Prove integration of the exact tip in one of two ways:

1. `git merge-base --is-ancestor "$tip_commit" main` returns 0 against the recorded local `main` commit.
2. GitHub reports a merged PR in this repository for the candidate branch and its recorded head commit is exactly the candidate tip. This covers squash and rebase merges when local ancestry cannot.

A closed PR, deleted remote branch, similar commit message, or green check is not integration evidence. If neither proof is available, skip the worktree.

## Present and confirm the plan

Show each eligible candidate's canonical path, branch, issue or task, tip commit, local `main` commit, clean status, integration proof, ignored-file preview, and exact commands. List skipped worktrees and why. Ask the owner to confirm the exact eligible set. A changed candidate state or set invalidates approval and requires a new audit and confirmation.

Immediately before each approved removal, repeat the path, branch, status, operation-state, tip, and integration checks. Stop if anything changed.

```sh
git worktree remove "$workspace_path"
git branch -d "$branch_name"
```

Do not use `--force`, `git branch -D`, `git clean -f`, or manual deletion for a registered Git worktree. If worktree removal fails, preserve the branch. If `git branch -d` fails, preserve the branch and report why. Verify that the removed path no longer appears in `git worktree list --porcelain` and report any retained branch, directory, or skipped target. Do not claim success until the registry and filesystem checks pass.
