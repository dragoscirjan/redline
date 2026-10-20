# Cleanup workspaces

`cleanup-workspaces` is the destructive companion to [`isolated-workspace`](../isolated-workspace/SKILL.md). It plans and safely removes clean integrated workspaces and prunes stale registrations after explicit confirmation.

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

## Safety model

Git candidates require a clean status, matching registration and branch tip, no active operation, and exact local ancestry to the selected base. Removal uses `git worktree remove` and `git branch -d` without force.

Git stale pruning runs only when every prunable registration is in scope. This prevents repository-wide `git worktree prune --expire now` from silently affecting another workspace root.

Jujutsu 0.38 or newer is required. Candidates require an exact integrated working-copy commit or an empty child whose parents are integrated. Cleanup uses `jj workspace forget` and `jj bookmark forget`, then removes only the revalidated workspace directory. An unresolved workspace root is skipped rather than inferred stale. Cleanup never abandons commits or propagates bookmark deletion.

Primary, active, dirty, locked, conflicted, unmerged, out-of-scope, and ambiguous workspaces remain protected. Apply mode repeats the audit and rechecks each candidate immediately before removal.

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
