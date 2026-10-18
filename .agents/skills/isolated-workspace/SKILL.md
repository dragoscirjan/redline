---
name: isolated-workspace
description: Create or reuse an issue-scoped Git worktree before changing Redline files. Use before any repository mutation; never write in the primary checkout or repurpose another task's workspace.
compatibility: Requires Git with worktree support.
metadata:
  author: dragoscirjan
  version: "1.1-redline"
  opencode/slash: "true"
---

# Isolated workspace

Use Redline's existing Git-only issue and worktree policy before the first repository mutation. Do not edit, generate, move, or delete repository files until this gate passes. This skill does not replace `grill-me`, issue creation, or the `CONTRIBUTING.md` validation gate.

## Read the project policy

Read the nearest `AGENTS.md` and `CONTRIBUTING.md`. Redline uses Git, branches from `main`, and stores dedicated worktrees under `../redline--workspaces/<branch-name>` relative to the primary checkout. The directory name uses the branch name with `/` replaced by `-`, as in `docs/134-agent-skills` at `../redline--workspaces/docs-134-agent-skills`. Do not use the generic ai repository's Jujutsu, fixed-prefix, or memory-derived workspace procedure.

For a change requiring an issue, wait until the owner confirms the intake and the issue exists. Choose one short branch name associated with that issue and type of work. If no issue is required, use a task-specific name. Do not silently reuse a branch from another issue or choose a category when the task is ambiguous. Use only safe branch components; never interpolate an untrusted issue title, `.` or `..` path component into a worktree path.

Set `branch_name` to the chosen issue or task branch. Derive `workspace_path` from the primary checkout with `workspace_name="$(printf '%s' "$branch_name" | tr '/' '-')"` and `workspace_path="../redline--workspaces/$workspace_name"`. Check its canonical path before creation.

## Protect existing work

- Never mutate the primary checkout or a worktree that belongs to another change.
- Never stash, reset, clean, move, or delete pre-existing user changes.
- Keep one active writer per worktree.
- Reuse a dedicated worktree for the same issue instead of creating another one.
- If the branch name or destination collides with unrelated work, stop and ask the owner.
- Do not fetch, pull, or change `main` merely to make a workspace preflight pass.

## Inspect before creation

From the primary checkout, inspect without mutating:

```sh
git status --short --branch
git worktree list --porcelain
git rev-parse main
git rev-parse origin/main
git branch --list "$branch_name"
```

Leave any pre-existing primary-checkout changes untouched. Record whether `main` and `origin/main` agree. Redline's `CONTRIBUTING.md` creates new issue branches from `origin/main`; use that ref without fetching, and report if it appears stale. Confirm the destination does not exist, the branch is not attached to another worktree, and its resolved path is outside the primary checkout. Create the parent directory only after those checks.

A workspace is reusable only when it is registered, its branch and path identify the same issue or task, and any existing modifications belong to that work. If it has unrelated or uncertain changes, stop. A clean dedicated workspace for the same issue remains reusable even if the primary checkout has changed since its creation.

## Create or reuse the Git worktree

For a new issue branch, from the primary checkout:

```sh
mkdir -p ../redline--workspaces
git worktree add "$workspace_path" -b "$branch_name" origin/main
git -C "$workspace_path" status --short --branch
```

If the branch already exists but is not attached and belongs to the same issue, deliberately attach it without `-b`:

```sh
git worktree add "$workspace_path" "$branch_name"
git -C "$workspace_path" status --short --branch
```

Do not run either creation command when the destination exists or the branch belongs to another worktree. A registered worktree at the correct path and branch needs no creation command.

## Verify the gate

Before changing files, confirm the absolute worktree path, branch, issue or task, base commit, and worktree status. Perform subsequent reads, writes, commands, validation, commits, and publication from that worktree. Pass the absolute path when a tool does not preserve `cd`.

Do not remove worktrees or branches during this gate. Use `cleanup-workspaces` only after an owner requests a cleanup audit and approves its exact removal plan.
