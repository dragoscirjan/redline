# Architecture and implementation status

## One application boundary

The agreed direction in [#234](https://github.com/dragoscirjan/redline/issues/234) is one shared review engine for local CLI, Docker and stdio RPC, with adapters for model protocols, tools, revision sources and forges.

Git capture and deterministic context bundles are implemented. The application-level review engine remains a prototype. `src/application/review.ts` declares:

- `ReviewTarget`, reusing revision-range and working-tree selection shapes from the preceding local CLI.
- `ReviewRequest`, carrying the repository, base, target and optional artifact directory. Trusted model bindings, credentials and permissions are not request fields.
- `ReviewResult`, describing terminal state and an optional artifact directory without CLI exit codes or renderer details.
- `ReviewApplication.review(request): Effect<ReviewResult, Error>`, the shared application operation.
- `ReviewApplication.layer`, its normal dependency-injection layer.

The method's comments state the intended flow: capture, model/tool warmup, file review, validation and artifact writing under shared lifecycle and budgets. Publication stays separate. The body contains only an explicit `Not implemented` failure. There is no special unavailable-domain service, error class or impossible success type.

The declarations let an architect inspect the intended direction. They do not establish a finished wire schema or detailed report contract. Importing the module does not run review work or throw the placeholder failure. Existing CLI behavior is preserved and is not wired to this prototype.

## Effect's intended responsibility

Effect `4.1.5` provides the service and layer types used in the skeleton. Once separately implemented, Effect is intended to own application lifecycle, expected failures, scopes, bounded concurrency, deadlines, cancellation and retry policy. SDKs should own their provider protocols and transport details.

The Git adapter now bounds its subprocess output, per-command time and captured data, propagates caller cancellation and owns its scratch cleanup. Shared Effect run budgets and model/tool lifecycle control are not implemented. There is no conversation loop, MCP connection, model driver, scheduler or application retry policy.

Keep pure validation and rendering functions direct. Do not wrap every helper in a service or create a runtime per function. Preserve existing authoritative validators rather than duplicate their schemas in Effect Schema. Use layers only for real dependency boundaries.

The project retains Vitest 3 and tests Effect results directly. It does not add `@effect/vitest`, whose matching release requires a different Vitest major.

## Preserved boundaries

| Area | Current state |
| --- | --- |
| CLI | Existing help/status work. Review and RPC fail explicitly. |
| Application | Disconnected review method prototype with normal request/result names and an unimplemented body. |
| Revision source | Working Git revision/worktree capture, immutable bundles, explicit coverage and caller-owned disposal. |
| Model and MCP | Reserved directories, no implementation or installed SDK adapters. |
| Review and publication | Deterministic eligibility and context bundles work. Finding validation, review reports and publication remain unimplemented. |
| Package | Capture and its active dependencies are packaged and tested through installed Node/Bun modules. Existing launchers still reject review/RPC execution. |
| Docker | Existing scaffold-only definition. No new image build or isolation claim. |
| Production workflows | Remain parked. |

Publication credentials must remain outside model/tool execution when those features return. Source content and tool/model output remain untrusted. The capture implementation does not weaken existing security or approval rules.

## Reuse decisions

- Preserve existing command behavior and the bodies in `bin/` and `scripts/build.js`. Rename the status helper to `applicationStatus` and its type to `ApplicationStatus`; update the CLI import without changing reported values.
- Reuse the selection concepts from `src.pre-v4/local/options.ts` and terminal-state/artifact-location concepts from `src.pre-v4/local/run.ts`. Keep them as active prototypes without importing archived modules.
- Adapt the offline package fixture from `archive/pre-v4/test/package.test.ts` and its `helpers/package-dependencies.ts` and `helpers/npm.ts`. The active fixture stages builds in temporary directories and packs installed production dependencies without registry access.
- Adapt `src.pre-v4/local/git-source.ts`, the Git-only sections of `local/process.ts`, `context-bundle.ts` and `review-eligibility.ts` into active modules. Remove the old standalone bundle CLI, tar extraction path and harness-specific process helpers. Require the bounded Git adapter rather than an implicit subprocess fallback. Add exclusive private output ownership and canonical repository-boundary executable checks.
- Preserve `src.pre-v4/review/runner.ts`, authoritative validators, RPC contracts and publication policy as references for later ports. Do not import them as a runtime fallback.
- Leave archived files, baseline discrepancies and owner edits unchanged.

## Tests and limits

Tests call the exported review method with a request, check explicit failure while its body is unfinished, and exercise CLI behavior and the packed/installed distribution. They do not freeze a placeholder error class as the domain API or mock private collaborators. Active Vitest discovery remains restricted to `test/**/*.test.ts`; historical suites are not counted as passing.

The package fixture includes historical/development sentinels before packing so archive-exclusion checks exercise the package allowlist. It tests both compiled Node and source Bun entrypoints outside the checkout.

Capture tests use real temporary repositories and cover SHA-1/SHA-256 revisions, working-tree modes, immutable bytes, trusted-base policy, bounds and preservation of source Git state. A controlled external Git process verifies POSIX cancellation, process termination and scratch/output cleanup without sleep-based synchronization. This does not establish Windows process-tree cleanup, model/tool cancellation, model compatibility, finding accuracy, live publication or Docker behavior.

See [Git capture](./capture.md) for the adapter contract, artifact layout and limits.

## Unfinished work

Before implementing review execution, resolve the contracts and migration decisions assigned to `N01` in the [proposed task plan](https://github.com/dragoscirjan/redline/issues/234#issuecomment-7054237458). That includes native model protocols and SDK bindings, tool permissions, budgets, configuration/output migration and replacement of temporary warmup-only behavior.

Then restore behavior in bounded, test-first slices using the historical source and regression tests. Review and refine the prototypes, port authoritative report schemas and define operational errors before implementing the flow. A passing capture gate is not completion of #234 and does not authorize dependency changes, publication, merging or release.

The draft's skill assets and protected instruction documents predate the current-main guidance used for this task. They remain unchanged and need a separately approved reconciliation before future work relies on their local routes.
