# Cleanup workspaces

`cleanup-workspaces` is the destructive companion to [`isolated-workspace`](../isolated-workspace/SKILL.md). It plans and safely removes clean integrated workspaces and prunes safe stale registrations after explicit confirmation. It also has exact-target cleanup for a temporary lane created under [`subagent-orchestration`](../subagent-orchestration/SKILL.md).

## Automation

The skill includes Bun-executed TypeScript automation:

- [`scripts/cleanup.ts`](scripts/cleanup.ts) audits, plans, rechecks, and applies cleanup.
- [`scripts/cleanup.test.ts`](scripts/cleanup.test.ts) exercises successful and protected Git and Jujutsu states.
- Shared repository and path helpers come from [`isolated-workspace/scripts/lib.ts`](../isolated-workspace/scripts/lib.ts).

The skill is model-discoverable, but loading it authorizes audit only. Read [`SKILL.md`](SKILL.md) before applying a plan. For the relative commands below, use this skill's directory inside a surviving target checkout as the working directory. If the helper is outside that checkout, invoke its absolute path from the surviving target checkout instead.

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

Use `--vcs jj` for Jujutsu. Before planning a lane, read [exact-lane identity, authorization, and cleanup](references/orchestration-lanes.md).

## Safety model

Ordinary cleanup requires the owner's exact-plan approval. The current-task lane exception permits only the parent to confirm the exact plan covered by its initial orchestration authorization.

Read the applicable eligibility and stale-registration rules before auditing or applying: [Git](references/git.md) or [Jujutsu](references/jj.md). The main workflow defines universal protected states and confirmation gates. These checks keep unproven or changed targets intact rather than forcing removal.

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

See [`SKILL.md`](SKILL.md) for the complete agent workflow and safety stops. Report the helper's actual diagnostics and exit status; partial cleanup failure is not success.
