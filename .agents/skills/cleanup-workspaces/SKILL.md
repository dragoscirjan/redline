---
name: cleanup-workspaces
description: "Audit integrated Git/Jujutsu workspaces, stale registrations, or authorized temporary lanes; apply only an approved exact cleanup plan."
requires: ["isolated-workspace"]
compatibility: Requires Bun and either Git with worktree support or Jujutsu 0.38 or newer with workspace support.
metadata:
  author: dragoscirjan
  version: "2.0"
  opencode/slash: "true"
---

# Cleanup workspaces

Use the bundled automation to audit isolated workspaces. Loading or invoking this skill authorizes audit only, never removal.

Ordinary cleanup requires the owner's approval of the exact plan. For one current-task temporary lane created under approved orchestration, its initial lane authorization permits the parent to confirm that exact cleanup plan. Preserve this exception's task and target limits.

## 1. Select the audit

Read applicable project instructions and workspace configuration. Pass `--vcs git` or `--vcs jj` explicitly; use only that VCS, including in colocated repositories. Pass a configured base through `--base`. Otherwise the helper uses the Git remote default branch, then current Git branch, or `trunk()` for Jujutsu.

Before auditing, read the selected eligibility rules: [Git](references/git.md) or [Jujutsu](references/jj.md). For `--lane`, also read [exact-lane cleanup](references/orchestration-lanes.md). These are required checks for their branches, not optional background.

Run ordinary cleanup from a surviving primary or other checkout. Run exact-lane cleanup from its surviving canonical sibling. Bun runs the helper without becoming a target dependency. Stop on missing Bun or VCS; installation and reconfiguration need owner approval.

## 2. Produce and inspect the plan

Resolve `<skill-directory>` to this skill's directory, then run:

```sh
bun <skill-directory>/scripts/cleanup.ts --vcs git --base main
```

Substitute the selected VCS and configured base. Default output is a JSON plan; `--dry-run` explicitly selects the same mode. The helper derives the primary local repository and sibling `<repository>--workspaces` root without hosted identity.

Review the complete candidate and skipped sets, primary repository and workspace root, base expression and commit, exact tips and ancestry evidence, removal commands, safe stale registrations, ignored-file warnings, and blocking limits. `planId` binds this full set. Preserve eligibility rather than adding force flags or widening targets.

## Protected state

Leave these workspaces untouched:

- The primary checkout, surviving canonical lane-cleanup workspace, and default Jujutsu workspace.
- The current process directory or a workspace containing it.
- Anything outside the derived root, or with an ambiguous, inaccessible, locked, detached, or conflicted state.
- Any workspace with detected file changes or an active Git merge, rebase, cherry-pick, revert, or bisect.
- A non-empty tip without proven ancestry into the selected base.
- Any registration whose path, repository, ref, or exact tip does not match.

Use local ancestry evidence. The helper neither fetches, pulls, rebases, moves bookmarks, updates the base, infers squash merges, nor consults hosting services. Unproven integration means skip.

## 3. Confirm and apply

Show the complete plan. Obtain the owner's exact confirmation for ordinary cleanup, or have the parent review and confirm a current-task lane covered by the stated exception.

Repeat the same command and append `--apply --confirm --plan-id PLAN_ID`.

Use the approved plan's actual ID. For lanes, repeat the exact `--lane` and canonical `--base`. The helper audits twice before mutation and re-audits each eligible workspace immediately before removal. Changed mode, target, canonical workspace/ref/tip, VCS, base, candidate or skipped sets, paths, refs, tips, ignored previews, limits, or operations stop the operation or candidate.

Apply only the selected VCS's documented safe removals. Never retry with `git worktree remove --force`, `git branch -D`, `git clean -f`, `jj abandon`, `jj bookmark delete`, or `rm -rf`.

## 4. Report actual results

Report removed workspaces and stale registrations, deleted Git branches or forgotten Jujutsu bookmarks, retained refs/directories, skipped targets and reasons, failed commands, partial results, and unavailable checks or limits.

Use JSON by default or `--format text` for a concise report. Partial failure exits nonzero; report it as partial failure rather than success. Cleanup grants no merge or release authority.
