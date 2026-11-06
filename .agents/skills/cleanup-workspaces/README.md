# Cleanup workspaces

`cleanup-workspaces` is the destructive companion to [`isolated-workspace`](../isolated-workspace/SKILL.md). It plans and safely removes clean integrated workspaces and prunes safe stale registrations after explicit confirmation. It also has exact-target cleanup for a temporary lane created under [`subagent-orchestration`](../subagent-orchestration/SKILL.md).

## Automation

The skill includes Bun-executed TypeScript automation:

- [`scripts/cleanup.ts`](scripts/cleanup.ts) audits, plans, rechecks, and applies cleanup.
- [`scripts/cleanup.test.ts`](scripts/cleanup.test.ts) exercises successful and protected Git and Jujutsu states.
- Shared repository and path helpers come from [`isolated-workspace/scripts/lib.ts`](../isolated-workspace/scripts/lib.ts).

`isolated-workspace` is a required sibling dependency. Consumers must resolve it by its advertised skill name and path; the cleanup skill never installs it automatically.

The caller must select the VCS explicitly:

```sh
bun scripts/cleanup.ts --vcs git --base main
bun scripts/cleanup.ts --vcs jj --base 'trunk()'
```

The script never infers Git versus Jujutsu. It detects the primary local repository and derives the sibling `<repository>--workspaces` directory.

The default mode emits a plan with a `planId`. Removal requires a later run with both mutation gates and that exact plan ID:

```sh
bun scripts/cleanup.ts --vcs git --base main \
  --apply --confirm --plan-id PLAN_ID
```

To clean one integrated orchestration lane, run from the surviving canonical sibling workspace, name the lane workspace leaf, and use the canonical ref as the explicit base:

```sh
bun scripts/cleanup.ts --vcs git \
  --lane issue-44--lane-worker-a --base change/issue-44
bun scripts/cleanup.ts --vcs git \
  --lane issue-44--lane-worker-a --base change/issue-44 \
  --apply --confirm --plan-id PLAN_ID
```

Use `--vcs jj` for Jujutsu. A temporary lane ref is `${CANONICAL_REF}--lane-${LANE_KEY}` and its workspace leaf is the basename of that ref. The `--lane-` marker is reserved, the lane key is one safe component, and a temporary lane cannot act as the canonical caller. Lane mode selects no other workspace, validates the target ref under the caller's canonical ref, disables stale/global cleanup, and binds the target plus canonical workspace, ref, tip, and base into the plan.

## Safety model

Git candidates require a clean status, matching registration and branch tip, no active operation, and exact local ancestry to the selected base. Removal uses `git worktree remove` and `git branch -d` without force. In lane mode both commands run from the surviving canonical workspace, after the target tip is proven to be an ancestor of canonical `HEAD`/base; this permits safe deletion even when the primary checkout has not merged the lane.

Git stale pruning runs only when every prunable registration is in scope. This prevents repository-wide `git worktree prune --expire now` from silently affecting another workspace root.

Jujutsu 0.38 or newer is required. Candidates require an exact integrated working-copy commit or an empty child whose parents are integrated. Cleanup uses `jj workspace forget` and `jj bookmark forget`, then removes only the revalidated original workspace path. In lane mode those commands run from the canonical workspace and the registered path must equal the named sibling target. Before every destructive step, cleanup rejects symlinks, path aliases, and changed directory identity; directory removal never dereferences a substituted path. An unresolved workspace root is skipped rather than inferred stale. Cleanup never abandons commits or propagates bookmark deletion.

Primary, canonical, active, dirty, locked, conflicted, detached, changed, stale, unmerged, out-of-scope, and ambiguous lane targets remain protected. Apply mode repeats the audit and rechecks each candidate immediately before removal.

## Tests

Run the cleanup tests from the repository root:

```sh
bun test ./.agents/skills/cleanup-workspaces/scripts/cleanup.test.ts
```

Run the complete workspace automation suite:

```sh
bun test \
  ./.agents/skills/isolated-workspace/scripts/create.test.ts \
  ./.agents/skills/cleanup-workspaces/scripts/cleanup.test.ts
```

See [`SKILL.md`](SKILL.md) for the complete agent workflow, safety stops, and exit codes.
