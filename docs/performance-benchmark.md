# Review performance benchmark

Redline has a fixed 20-file performance corpus under `benchmark/performance/v1/`. It measures the bounded per-file review scheduler and records the effect of each integrated performance-epic change. The separate [model execution benchmark](/model-execution-benchmark) selects Pi thinking, output, retry, deadline, and process-isolation policy.

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

PR #169 workflow run `40125277504` measured a 113.55 MiB store. Four exact-key misses installed in 1,043–1,489 ms (p50 1,160 ms); six warm exact-key hits installed in 504–1,089 ms (p50 546 ms). Removing project setup from the timed review action reduced the observed Node smoke from 14,097 ms to 6,712–8,651 ms and the Bun smoke from 9,771 ms to 4,284–7,151 ms. These are deterministic echo-harness samples, not model-bound latency measurements.

`node_modules` remains uncached because this capture does not prove a net benefit over restoring the 113.55 MiB pnpm store and running the frozen linker. The complete evidence is checked in at `benchmark/dependency-install/v1/ci-pr-169.json`.

The baseline uses four workers and largest-diff-first scheduling. It retains 1,208 seconds of total modeled model work and models 340 seconds of review wall time. The previous sequential baseline reported 1,260.8 seconds warm-index p95 and 1,474.3 seconds cold-index p95. The four-worker baseline reports 392.8 seconds warm and 606.3 seconds cold. Both are below the epic targets, but the report remains SLO-ineligible until at least five current live fixed-corpus runs pass the quality gate.

## Review eligibility evidence

The separate deterministic report under `benchmark/review-eligibility/v1/` measures low-value generated classes before Redline enables repository-specific exclusions. PR #171 run `40132029782` observed one raw `benchmark/**/capture.json` file with 63,669 diff bytes, about 15,918 estimated input tokens, 3,987 ms of model work, and no findings or rejected candidates. That file represented 30.03% of the pull request's diff bytes.

Redline therefore excludes only raw benchmark captures in its exact-base `.redline/review-eligibility.json`. Generated benchmark reports remain reviewable because they carry conclusions. No generated snapshots were observed, so snapshot exclusions remain configurable rather than default. Run `mise run benchmark:review-eligibility` to regenerate the JSON and Markdown report. See [review eligibility](/review-eligibility) for the policy and trust boundary.

## Prompt-volume comparison

The performance benchmark assembles a full-file baseline prompt in a recorded prepass, then executes the focused production prompt. The prepass does not contribute to review latency. Both variants use the same policy, diff, indexed context, and recorded clean responses.

On the representative 20-file corpus, focused source selection reduces aggregate prompt volume from 388,473 to 266,257 bytes: 122,216 bytes, or 31.46%. The median file saves 2,434 bytes, or 15.34%. The stable four-characters-per-token estimate falls from 97,132 to 66,579 input tokens, a reduction of 30,553. Every corpus file is smaller with the focused strategy. The review-quality corpus separately replays both strategies and records unchanged root-cause, evidence, false-positive, and coverage results.

## Checkout and exact-revision measurement

The separate [checkout benchmark](/checkout-benchmark) compares full-history, shallow exact-revision, and blobless partial Git strategies on pinned Redline and Visual Studio Code revisions. It separates checkout, exact fetch, object hydration, context-bundle, index-source-export, object-store, and critical-path measurements. Synthetic tests prove fork, force-push, merge-commit, and shallow-history behavior before any production change.

Final workflow run [`40194071271`](https://github.com/dragoscirjan/redline/actions/runs/40194071271) completed five samples per repository and strategy. Full checkout was stable and fastest on Redline at 1.598 seconds p95. On VS Code, full checkout was 146.676 seconds p95; shallow was 37.245 seconds and partial was 61.240 seconds, but both alternatives changed the authoritative context bundle and failed correctness. Redline therefore retains full checkout. No correct uncached alternative crossed the combined 30-second and 5% gate, so Git object caching remains out of scope.

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
- per-file and aggregate full-file baseline bytes, focused prompt bytes, byte reduction, and median reduction;
- baseline and focused estimated input tokens plus estimated token reduction;
- bounded stdout/stderr byte counts and estimated output tokens;
- output truncation state;
- warm and cold index timing distributions;
- omissions, invalid records, rejected candidates, findings, coverage, and publication status.

The four-characters-per-token values are estimates. Actual token counts and cost remain `null` until a harness exposes bounded provider usage metadata.

Reports never contain prompts, source text, model responses, raw reasoning, credentials, or publication tokens.

## Timing boundaries

The checked-in index profile uses bounded timings from named production runs. Live corpus runs combine their measured review wall time with those fixed production samples, including sampled production publication latency. The locally measured publication duration is reported for each run but is not added to the end-to-end totals. The report states this limitation explicitly. Issue #153 owns the broader CGC/GitNexus value and latency comparison.

Publication uses the production forge-neutral service with an in-memory publisher. It measures validation, rendering, planning, and orchestration, but not GitHub network latency.
