---
name: isolated-workspace
description: "Create or reuse an isolated Git worktree or Jujutsu workspace before mutation, using an explicit VCS and branch or bookmark."
compatibility: Requires Bun and either Git with worktree support or Jujutsu 0.38 or newer with workspace support.
metadata:
  author: dragoscirjan
  version: "2.0"
  opencode/slash: "true"
---

# Isolated workspace

Establish a dedicated workspace before the first repository mutation. Until this gate passes, leave repository files unchanged. Use the bundled automation rather than recreating its path or VCS procedures.

Keep one canonical integration and pull-request workspace. Every workspace has one writer. Preserve pre-existing changes without stashing, resetting, cleaning, moving, or deleting them; never mutate the primary checkout.

## 1. Resolve the inputs

Read applicable `AGENTS.md` configuration. Obtain the selected VCS, configured base, and full branch or bookmark name, including its required prefix.

Pass `--vcs git` or `--vcs jj` explicitly and use only that VCS throughout, including in colocated repositories. Pass the full name through `--branch` and the configured base through `--base`. Without a configured base, the helper uses the Git remote default branch, then the current Git branch, or `trunk()` for Jujutsu.

For an approved temporary orchestration lane, read [lane creation](references/orchestration-lanes.md) before selecting its ref and base. Keep workspaces unnested.

Bun runs the helper without becoming a target dependency. Stop if Bun or the selected VCS is missing. Tool installation or reconfiguration needs owner approval.

## 2. Review the plan

Resolve `<skill-directory>` to this skill's directory, then run:

```sh
bun <skill-directory>/scripts/create.ts \
  --vcs git \
  --branch change/issue-42 \
  --base main
```

Select `--vcs jj` for Jujutsu and substitute the approved name and base. Default output is a JSON plan; `--dry-run` explicitly selects the same mode.

The helper detects the primary local repository and derives its sibling `<repository>--workspaces` directory without hosted identity or remote URLs. Review the VCS, primary repository, base expression and resolved commit, full ref, workspace name and absolute path, create/attach/repair/reuse action, exact commands, and `planId`.

Stop on unsafe names, path escapes, symlinked roots, unregistered destinations, conflicting names, or branches attached elsewhere. Reuse requires an exact registered path and ref match. Inspect a reused workspace's status and confirm that every existing change belongs to this task; the helper cannot establish ownership.

Continue only with a verified exact reuse or the human's approval of the complete plan.

## 3. Apply and verify

For creation, attachment, or repair, repeat the approved command and append `--apply --confirm --plan-id PLAN_ID`.

Use the approved plan's actual ID. The helper rebuilds the plan and stops when its ID, action, path, or resolved base changes. Git creates a branch from the base or attaches an existing branch only when unattached elsewhere. Jujutsu adds a named workspace, describes its change with the full bookmark name, and creates that bookmark at `@`.

Reuse is idempotent only while registration, path, and ref match. Repair a missing Jujutsu bookmark only when the exact registered workspace's description equals the requested full name; preserve existing bookmarks.

Require successful apply output or exact reusable state. Verify and report VCS, absolute workspace path, resolved base, branch or bookmark, and current status.

## Handoff

Run all subsequent reads, writes, commands, checks, commits, and publication from the verified isolated workspace. Pass its absolute working directory when a tool does not preserve `cd`.

JSON is the default output; `--format text` selects a concise report. Report bounded diagnostics and actual failures, with credential-bearing values redacted.

Stop after establishing the workspace. The project or user selects cleanup separately. Creation grants no cleanup, merge, or release authority.
