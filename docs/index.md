# Check the local implementation

This guide is for developers working on Initiative 4.0. Git capture is implemented through a module API; the complete review engine is not. This page describes the local command, not the previously published package.

## Prerequisites

Use an approved isolated worktree with the pinned Node, Bun and pnpm tools and locked dependencies already installed. Follow the repository's `CONTRIBUTING.md` for setup and approval requirements. No model credentials or network services are needed for these checks.

## Build and inspect status

From the worktree root, build the Node distribution:

```sh
mise run build
```

The build generates compiled files in `dist/`. Then inspect the local command:

```sh
mise exec -- node bin/redline.mjs --help
mise exec -- node bin/redline.mjs status --json
```

Help identifies review execution as unavailable. The JSON status includes `phase: "scaffold"`, `review: "not-implemented"`, and `publication: "not-implemented"`.

To use Bun's TypeScript path through the same launcher:

```sh
mise exec -- env REDLINE_ENV=bun node bin/redline.mjs status --json
```

Bun reports the same scaffold capabilities. Neither status command contacts a model, discovers MCP tools, reads review inputs or creates review artifacts. For the working revision-source adapter, see [Git capture](./capture.md).

## Recognize unavailable operations

```sh
mise exec -- node bin/redline.mjs review
mise exec -- node bin/redline.mjs rpc
```

Each command prints an unavailable diagnostic and exits with code `2`. This is intentional. There is no hidden fallback to the historical implementation and no clean-review result. The `redline-review` executable also rejects review execution.

The disconnected Effect application prototype declares `review(request)` and a normal dependency layer. Its body fails with `Not implemented` until review execution is implemented. This placeholder is not a domain error contract. The proposed structure is described in the [architecture guide](./architecture.md).

## Validate a change

```sh
mise run validate
```

The gate runs type checking, active Vitest/Bats tests and this site's build. Package tests stage and compile files in temporary directories, pack production dependencies locally, and install with network access disabled and scripts ignored. They check Node and Bun, including real installed-module Git capture, the unfinished review method and archive exclusion. Capture integration tests also exercise immutable snapshots, bounds, trusted-base eligibility, cancellation and cleanup.

Historical tests are not part of the active suite. Passing these checks is not proof of review correctness or live model support.

## Recover from setup failures

If the launcher reports a missing compiled entrypoint, run `mise run build` before using Node. If a pinned tool or dependency is missing, follow the contribution setup procedure; do not switch package managers or bypass the dependency policy.

For architecture and the next implementation boundaries, read [what remains unfinished](./architecture.md#unfinished-work).
