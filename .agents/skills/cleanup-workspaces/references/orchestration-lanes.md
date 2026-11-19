# Clean one orchestration lane

Read this before planning cleanup with `--lane`. It applies only to one temporary lane created for the current task under approved orchestration.

## Identify the exact target

Use the direct ref `${CANONICAL_REF}--lane-${LANE_KEY}` with a one-component lane key. The workspace name and leaf must equal its basename. Pass that non-empty workspace name through `--lane`, not a branch or bookmark path.

Run from the surviving non-primary canonical workspace. Pass its full attached Git branch or matching Jujutsu bookmark through `--base` at its exact current tip. Canonical refs must not contain the reserved `--lane-` marker.

For example, from the workspace for `change/issue-44`:

```sh
bun <skill-directory>/scripts/cleanup.ts \
  --vcs git \
  --lane issue-44--lane-worker-a \
  --base change/issue-44
```

Select `--vcs jj` instead for Jujutsu. Resolve `<skill-directory>` to this skill's directory before running the command.

## Check the bound plan

Require all of these conditions:

- The target is the exact registered sibling at `<repository>--workspaces/WORKSPACE_NAME`.
- The target branch or bookmark equals the direct lane ref, and its workspace leaf matches.
- The caller is the surviving canonical workspace, never a temporary lane. The canonical workspace is not the target.
- The selected base is the caller's canonical ref at its exact tip. Reject sibling lanes presented under a false canonical base and nested lane provenance.
- The target tip, or eligible empty Jujutsu child, is integrated into that base.
- The target is neither active, dirty, locked, conflicted, detached, changed, stale, inaccessible, mismatched, nor unintegrated.

Lane mode disables unrelated candidate scanning, stale pruning, and global cleanup. Its `planId` binds the mode, target, current canonical workspace and ref, canonical tip, and resolved base. The VCS-specific eligibility and removal rules still apply.

## Confirm without widening authority

The owner's initial authorization of this current task's temporary lane permits the parent to confirm its exact reviewed cleanup plan. It permits neither ordinary cleanup nor cleanup for another task or unrelated workspace.

Repeat the same `--lane` and canonical `--base` with the main workflow's `--apply --confirm --plan-id PLAN_ID` gates. Stop on any changed or rejected state; keep the target and report the reason.
