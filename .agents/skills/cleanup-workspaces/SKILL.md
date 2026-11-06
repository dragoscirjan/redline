---
name: cleanup-workspaces
description: Plan and safely remove clean integrated Git worktrees or Jujutsu workspaces, including one exact temporary orchestration lane, and prune safe stale registrations. Use for owner-authorized cleanup or current-task lane cleanup authorized by the orchestration workflow.
disable-model-invocation: true
compatibility: Requires Bun and either Git with worktree support or Jujutsu 0.38 or newer with workspace support.
metadata:
  author: dragoscirjan
  version: "2.0"
  opencode/slash: "true"
---

# Cleanup workspaces

Audit isolated workspaces with deterministic TypeScript automation. Show the complete plan before removal. Loading or invoking this skill authorizes an audit only; it does not authorize mutation.

Ordinary cleanup requires explicit owner authorization. For one current-task temporary lane created under the approved `subagent-orchestration` workflow, the owner's initial lane authorization permits the parent to confirm the exact lane plan without another owner round trip. It does not authorize another task, ordinary cleanup, or a broader target.

Run ordinary cleanup from the primary checkout or another workspace that will survive. Run exact lane cleanup from the surviving canonical sibling workspace. Read the nearest `AGENTS.md` and the `isolated-workspace` skill first.

This skill depends on `isolated-workspace` and imports its advertised `scripts/lib.ts` helper through the sibling skill path. If that skill or helper is unavailable, stop. Do not install a missing dependency without owner approval and do not recreate it from memory.

## Select the VCS and base

The script requires `--vcs git` or `--vcs jj`. It never infers the VCS, including in a colocated repository. Use only that tool for the complete audit and apply operation.

Pass the project-configured base through `--base`. When omitted, the script uses the Git remote default branch, then the current Git branch, or `trunk()` for Jujutsu.

Bun runs the helper but is not added to the target repository. If Bun or the selected VCS is unavailable, stop. Do not install or reconfigure tools without owner approval.

## Produce the plan

Resolve this skill's directory, then run:

```sh
bun <skill-directory>/scripts/cleanup.ts --vcs git --base main
```

Use `--vcs jj` for Jujutsu. The default is a structured JSON plan. `--dry-run` is an optional explicit alias for plan mode.

The script detects the primary local repository and derives its sibling `<repository>--workspaces` directory. Hosted-repository identity is not required.

The plan reports:

- primary repository and workspace root
- base expression and exact resolved commit
- every eligible workspace, exact tip, integration evidence, and removal command
- every stale registration that can be pruned safely
- every skipped workspace and its reason
- ignored Git files that worktree removal can delete
- limits that block otherwise possible cleanup
- the `planId` that binds apply mode to this exact candidate and skipped set

Do not add force flags or manually widen the eligible set.

## Clean one orchestration lane

Use `--lane WORKSPACE_NAME` only for one temporary lane created for the current task. The lane ref must be `${CANONICAL_REF}--lane-${LANE_KEY}` and `WORKSPACE_NAME` must be its basename. Pass the surviving canonical branch or bookmark exactly as `--base` and run the command from its canonical workspace:

```sh
bun <skill-directory>/scripts/cleanup.ts \
  --vcs git \
  --lane issue-44--lane-worker-a \
  --base change/issue-44
```

Use `--vcs jj` for Jujutsu. `--lane` accepts the non-empty workspace name, not a branch or bookmark path. The `--lane-` marker is reserved for temporary lane refs; canonical refs containing it are rejected as callers.

Lane mode:

- selects only the exact registered sibling workspace at `<repository>--workspaces/WORKSPACE_NAME`
- disables unrelated candidate scanning, stale pruning, and global cleanup
- requires the current workspace to be the surviving non-primary canonical workspace
- requires `--base` to name the canonical workspace's attached Git branch or matching Jujutsu bookmark at its exact current tip
- requires the target Git branch or Jujutsu bookmark to equal `${CANONICAL_REF}--lane-${LANE_KEY}` and the workspace leaf to match its basename
- rejects a temporary lane caller, the canonical workspace as target, sibling lanes presented under a fake canonical base, and nested lane provenance
- binds lane mode, target, current canonical workspace and ref, canonical tip, and resolved base into `planId`
- requires the target tip or eligible empty Jujutsu child to be integrated into that canonical base
- rejects active, dirty, locked, conflicted, detached, changed, stale, inaccessible, mismatched, or unintegrated targets

For Git, worktree removal and `git branch -d` run from the surviving canonical workspace. This lets safe branch deletion use the canonical `HEAD` after ancestry proves the lane tip is integrated there; it does not weaken primary-checkout protection or use force deletion.

For Jujutsu, workspace and bookmark forgetting run from the surviving canonical workspace. The original registered path, directory identity, non-symlink state, and in-root location are revalidated before each destructive step; removal uses that exact original path without dereferencing it and without force.

## Protected state

The automation never selects:

- the primary checkout, canonical lane-cleanup workspace, or default Jujutsu workspace
- the current process directory or a workspace that contains it
- a workspace outside the derived workspace root
- a locked, detached, conflicted, inaccessible, or ambiguous workspace
- a Git workspace with an active merge, rebase, cherry-pick, revert, or bisect
- a workspace with detected file changes
- a non-empty candidate tip that is not an ancestor of the selected base
- a workspace whose registered path, repository, ref, or exact tip does not match

It does not fetch, pull, rebase, move bookmarks, update the base, infer squash merges, or consult a hosting service. If local ancestry does not prove integration, the workspace remains skipped.

## Git eligibility and stale registrations

A registered Git worktree is eligible only when:

1. its canonical path is inside the derived workspace root
2. it is not primary, active, locked, detached, or missing
3. it uses the same Git common directory
4. `git status --porcelain=v1 --untracked-files=all` is empty
5. no Git operation is active
6. the registered `HEAD`, checked-out branch, and branch tip match
7. `git merge-base --is-ancestor <tip> <base>` succeeds

The plan includes `git clean -ndX` output as a warning only. The script never runs `git clean -f`.

In exact lane mode, Git requires the registered path to equal the named sibling target and proves the target tip is an ancestor of canonical `HEAD`/base. It does not run repository-wide pruning. Branch deletion runs from the canonical workspace rather than the primary checkout.

Missing registered worktrees are stale. Git pruning is repository-wide, so the script runs `git worktree prune --expire now --verbose` only when every currently prunable registration is inside the derived workspace root. If any prunable registration is out of scope, all automatic Git pruning is disabled and the limit is reported.

After pruning, a stale branch is deleted only when its recorded tip is unchanged and integrated.

## Jujutsu eligibility and stale registrations

A registered Jujutsu workspace is eligible only when:

1. its canonical path is inside the derived workspace root
2. it is not the default or active workspace
3. a working-copy snapshot succeeds without conflicts
4. the exact working-copy commit is integrated, or it is empty and every parent is integrated
5. any matching local bookmark is unambiguous and targets the audited tip or integrated parent

The ancestry query must select exactly the candidate commit through `<tip> & ::<base>`.

`jj status` refreshes Jujutsu's working-copy snapshot during audit. This can update repository metadata but does not edit workspace files or refs. If the snapshot changes the audited commit, the current run skips that workspace and requires another audit.

Treat a Jujutsu registration as stale only when `jj workspace root --name` resolves its registered root and that path is missing. If Jujutsu cannot resolve the root, classify the workspace as inaccessible and skip it. Never infer staleness from the derived path alone. Forgetting a proven stale registration preserves its bookmark and commit unless the normal eligible-workspace checks independently authorize bookmark cleanup. Exact lane mode rejects stale registrations and never broadens cleanup beyond the named target.

## Confirm and apply

Show the complete plan before mutation. For ordinary cleanup, the owner confirms that exact plan. For a current-task lane covered by the orchestration authorization above, the parent may confirm the exact plan after reviewing it.

Then rerun the same command with both mutation gates:

```sh
bun <skill-directory>/scripts/cleanup.ts \
  --vcs git \
  --base main \
  --apply \
  --confirm \
  --plan-id PLAN_ID
```

Replace `PLAN_ID` with the value emitted by the approved plan-mode run. For lane mode, repeat `--lane WORKSPACE_NAME` and the canonical `--base`. Apply mode requires `--apply`, `--confirm`, and the matching `--plan-id`. It audits twice before mutation and compares the cleanup mode, target, current canonical workspace and ref, VCS, base, candidate and skipped sets, canonical paths, refs, tips, ignored-file previews, limits, and operations. It also re-audits each eligible workspace immediately before removal. Any changed state stops the operation or candidate.

Git removal uses only:

```sh
git worktree remove <workspace-path>
git branch -d <branch>
```

Ordinary mode runs these commands from the primary repository. Exact lane mode runs them from the surviving canonical workspace recorded in the plan.

Jujutsu removal uses `jj workspace forget`, then `jj bookmark forget` for an eligible local bookmark, then removes the exact confirmed original directory without force. It revalidates the original path and directory identity immediately before each destructive step and reports partial failures without following a substituted symlink.

Never retry with `git worktree remove --force`, `git branch -D`, `git clean -f`, `jj abandon`, `jj bookmark delete`, or `rm -rf`.

## Report results

Report:

- removed workspaces and stale registrations
- deleted Git branches and forgotten Jujutsu bookmarks
- retained refs or directories
- skipped workspaces and reasons
- failed commands and partial results
- limits or checks that could not run

JSON is the default output. Use `--format text` for a concise report. A partial failure exits nonzero.

Exit codes are:

- `0`: success
- `2`: invalid arguments or missing confirmation
- `3`: state or safety conflict
- `4`: missing environment prerequisite
- `5`: VCS command or partial cleanup failure
- `6`: filesystem or unexpected failure

Cleanup does not authorize merge or release.
