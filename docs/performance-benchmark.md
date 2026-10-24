# Review performance benchmark

Redline has a fixed 20-file performance corpus under `benchmark/performance/v1/`. It measures the bounded per-file review scheduler before later performance-epic changes to caching, indexing, prompts, or model execution.

The corpus contains:

- six ordinary TypeScript files;
- four TypeScript test files;
- three configuration files;
- three documentation files;
- two large TypeScript files;
- two generated-like JSON artifacts.

Every change is intentionally clean. A run fails its quality gate if any file is omitted, produces invalid output, produces a finding, loses required coverage, or fails publication through the forge-neutral publication service.

## Run the recorded baseline

```bash
mise run benchmark:performance
```

The command executes Redline's TypeScript source directly, runs the fixed corpus through the production bundle loader, prompt builder, harness contract, result validator, output writer, PR-level contract, and publication service, then writes:

- `benchmark/performance/v1/baseline/report.json`
- `benchmark/performance/v1/baseline/report.md`

Recorded mode performs no network requests. It uses checked-in per-file model durations and bounded timing samples from named production Action runs. The report marks the SLO gate as **not eligible** because recorded data cannot prove current live latency.

## TypeScript source runtime measurement

`mise run benchmark:source-runtime` measures the pinned runtimes against direct TypeScript source. It runs five context-only CLI validation starts and three deterministic echo review pipelines per runtime. The checked-in captures are under `benchmark/source-runtime/v1/`.

| Runtime | CLI startup p50/p95 | Echo review p50/p95 |
| --- | ---: | ---: |
| Node 24.21.0 | 64/67 ms | 165/184 ms |
| Bun 1.4.4 | 13/14 ms | 79/85 ms |

These local process samples exclude dependency installation, harness installation, indexing, model calls, network latency, and publication. On pull requests, the CI source-runtime matrix separately times the root composite action end to end under both selected runtimes and uploads `action.json` with the runtime, outcome, and duration.

PR #168 workflow run `40121913292` supplied the first GitHub-hosted runner capture:

| Runtime | CLI startup p50/p95 | Echo review p50/p95 | Composite action |
| --- | ---: | ---: | ---: |
| Node 24.21.0 | 145/156 ms | 371/372 ms | 14,097 ms |
| Bun 1.4.4 | 16/16 ms | 123/125 ms | 9,771 ms |

Both composite-action runs succeeded with the deterministic echo harness and indexing disabled. This is one runner capture, not a latency distribution. Bun is faster in the bounded local and CI captures, but model work dominates live reviews, so Node remains the default and these results do not claim an end-to-end model-bound latency improvement. The complete capture is checked in at `benchmark/source-runtime/v1/ci-pr-168.json`.

## CI dependency-store cache

The production review action executes trusted TypeScript source without running Corepack, installing project dependencies, or type-checking. CI and documentation jobs retain the frozen dependency install through `.github/actions/install-dependencies`:

- pnpm is pinned to 10.33.0 and lifecycle scripts are disabled;
- the content-addressed store uses an exact versioned key bound to runner OS, architecture, Node 24, pnpm 10.33.0, and the complete `pnpm-lock.yaml` digest;
- the cache contains only the dedicated pnpm store, never `node_modules`;
- a restore failure becomes a normal frozen install, and a restored store that fails installation is removed and retried once from an empty store;
- cache saves are skipped above 512 MiB and save failures do not change the install result;
- every job writes and uploads versioned JSON telemetry with cache disposition, install duration, and store size.

`node_modules` remains uncached because no recorded comparison proves a net benefit over restoring the pnpm store and running the frozen offline-capable linker. Cold/warm CI measurements and the review-action startup delta are recorded with the implementation evidence; neither changes the model-bound latency claim above.

The baseline uses four workers and largest-diff-first scheduling. It retains 1,208 seconds of total modeled model work and models 340 seconds of review wall time. The previous sequential baseline reported 1,260.8 seconds warm-index p95 and 1,474.3 seconds cold-index p95. The four-worker baseline reports 392.8 seconds warm and 606.3 seconds cold. Both are below the epic targets, but the report remains SLO-ineligible until at least five current live fixed-corpus runs pass the quality gate.

## Run an opt-in live capture

A live capture uses the pinned profile:

- Pi;
- OpenRouter's OpenAI-compatible endpoint;
- `z-ai/glm-5.3-flash`;
- CGC 0.5.7 context;
- bounded parallel execution with four workers.

Run at least five fixed-corpus repetitions to make the SLO gate eligible. This minimum applies to benchmark executions, not to the number of historical workflow-stage samples in each cache condition:

```bash
REDLINE_LIVE_BENCHMARK=1 \
REDLINE_HARNESS=pi \
REDLINE_MODEL_CONFIG='{"provider":"openrouter","endpoint":"https://openrouter.ai/api/v1","model":"z-ai/glm-5.3-flash"}' \
REDLINE_MODEL_AUTH='{"openrouter":"..."}' \
mise run benchmark:performance-live -- \
  --runs 5 \
  --output /tmp/redline-performance-live
```

The live output path is mandatory. Live reports use owner-only file permissions. The selected credential and endpoint credential value are never written to the report.

The warm-index target is p95 at or below 10 minutes. The cold-index target is p95 at or below 15 minutes. The warm condition represents a validated exact-base cache hit and therefore requires `indexMs: 0`; the cold condition includes provider indexing. A target cannot pass unless all live runs pass the quality gate.

## Measurements

Each report contains:

- review wall time, total model work, configured concurrency, and maximum active model calls;
- publication duration;
- per-file queue wait and model duration;
- process startup and time to first streamed model text when available;
- prompt and bounded stdout/stderr byte counts;
- estimated input and output tokens;
- output truncation state;
- warm and cold index timing distributions;
- omissions, invalid records, rejected candidates, findings, coverage, and publication status.

The four-characters-per-token values are estimates. Actual token counts and cost remain `null` until a harness exposes bounded provider usage metadata.

Reports never contain prompts, source text, model responses, raw reasoning, credentials, or publication tokens.

## Timing boundaries

The checked-in index profile uses bounded timings from named production runs. Live corpus runs combine their measured review wall time with those fixed production samples, including sampled production publication latency. The locally measured publication duration is reported for each run but is not added to the end-to-end totals. The report states this limitation explicitly. Issue #153 owns the broader CGC/GitNexus value and latency comparison.

Publication uses the production forge-neutral service with an in-memory publisher. It measures validation, rendering, planning, and orchestration, but not GitHub network latency.
