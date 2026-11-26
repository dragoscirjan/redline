---
name: isolated-workspace
description: "Create a dedicated task branch or bookmark before repository edits. Choose the current checkout or an isolated Git worktree or Jujutsu workspace; ask the user when the location is unclear."
compatibility: Requires Git or Jujutsu 0.38 or newer. The isolated path also requires Bun.
metadata:
  author: dragoscirjan
  version: "3.0"
  opencode/slash: "true"
---

# Task branch and working location

Every new modifying task needs a dedicated task branch, or a dedicated change and bookmark for Jujutsu. A separate workspace is optional. Read-only investigation needs neither. Continue an existing task ref only when resuming the same task.

Keep one canonical integration and pull-request directory. Use one writer per working directory. Preserve unrelated changes and existing refs. Setup grants no cleanup, commit, publication, merge, or release authority.

## 1. Resolve the task ref

Inspect applicable project instructions, repository status, and existing working directories. Select Git or Jujutsu explicitly, including in colocated repositories. Obtain the base revision and full task branch or bookmark name with any configured prefix. Ask for unresolved inputs rather than inferring ownership from a name.

For a new task, require a new ref. For continuation, verify that the existing ref, directory, and every existing change belong to this task. An unrelated feature branch is not a task branch for the new work. Leave conflicting refs and uncertain changes untouched.

Continue when the VCS, base, full task ref, and new-task or continuation status are established.

## 2. Choose the working location

Honor an explicit user choice and applicable project constraints. Otherwise choose from task requirements and repository state:

- Prefer the current checkout for a single writer with a suitable clean starting point and no need to keep another checkout available.
- Prefer a separate workspace for simultaneous writers, a different base, or unrelated work that must remain available in the current directory.
- Check task-local files, environment setup, and changes that a fresh workspace would not contain. A worktree is not a copy of uncommitted work.

Ask the user when the preference, ownership, or practical trade-off is unclear. Explain the recommendation and offer the current checkout or a separate workspace. Keep the answer task-scoped unless the user explicitly extends it. Location selection does not replace concrete operation approval required below or by the project.

Continue when the chosen directory can satisfy task-ref creation and preserve existing work. For approved temporary orchestration lanes, read [lane creation](references/orchestration-lanes.md); simultaneous writers need separate working directories.

## 3. Establish the selected location

For the current checkout, follow [current-checkout setup](references/current-checkout.md). This path does not use the isolation helper or require Bun.

For a separate workspace, use the bundled automation below. Keep workspaces unnested. Stop if Bun or the explicitly selected VCS is missing; tool installation needs owner approval. A failed isolated setup is not permission to switch to in-place work.

### Plan an isolated workspace

Resolve `<skill-directory>` to this skill's directory, then run:

```sh
bun <skill-directory>/scripts/create.ts \
  --vcs git \
  --branch change/issue-42 \
  --base main
```

Select `--vcs jj` for Jujutsu. Pass the full task ref through `--branch` and the configured base through `--base`. Without a configured base, the helper uses the Git remote default branch, then the current Git branch, or `trunk()` for Jujutsu. Default output is a JSON plan; `--dry-run` selects the same mode.

The helper detects the primary local repository and derives its sibling `<repository>--workspaces` directory without hosted identity. Review the VCS, primary repository, base expression and resolved commit, full ref, workspace name and absolute path, create/attach/repair/reuse action, exact commands, and `planId`.

For a new task, verify that the planned action creates its new task ref. Attach, repair, and reuse apply only to a verified continuation. Stop on unsafe names, path escapes, symlinked roots, unregistered destinations, conflicting names, branches attached elsewhere, or uncertain ownership.

Continue only with verified exact same-task reuse or the human's approval of the complete plan.

### Apply and verify isolation

For creation, attachment, or repair, repeat the approved command and append `--apply --confirm --plan-id PLAN_ID`. Use the actual approved ID. The helper rebuilds the plan and stops when its ID, action, path, or resolved base changes.

Git creates a branch from the base or attaches an existing same-task branch only when unattached elsewhere. Jujutsu adds a named workspace, describes its change with the full bookmark name, and creates that bookmark at `@`. Repair a missing bookmark only when the exact registered workspace's description equals the requested full name; preserve existing bookmarks.

Require successful apply output or exact reusable state. Verify the task ref and status in the selected directory before task edits.

## Handoff

Report the VCS, task branch or bookmark, resolved base, absolute working directory, and status. State whether a separate workspace was created, reused, or not used. Task-ref setup is complete only when both the ref and working directory are verified.

Run subsequent task commands from that directory. Pass its absolute working directory when a tool does not preserve `cd`. Keep bounded diagnostics and redact credential-bearing values.

Stop after setup. The project or user selects implementation and cleanup separately.
