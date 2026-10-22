# Review performance benchmark

Redline has a fixed 20-file performance corpus under `benchmark/performance/v1/`. It measures the current one-file-at-a-time review path before the performance epic changes scheduling, caching, indexing, prompts, or model execution.

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

The command rebuilds Redline, runs the fixed corpus through the production bundle loader, prompt builder, harness contract, result validator, output writer, PR-level contract, and publication service, then writes:

- `benchmark/performance/v1/baseline/report.json`
- `benchmark/performance/v1/baseline/report.md`

Recorded mode performs no network requests. It uses checked-in per-file model durations and bounded timing samples from named production Action runs. The report marks the SLO gate as **not eligible** because recorded data cannot prove current live latency.

The baseline is sequential. It records 1,208 seconds of modeled review time before index and orchestration cost. Its recorded warm-index and cold-index p95 values exceed the epic targets.

## Run an opt-in live capture

A live capture uses the pinned profile:

- Pi;
- OpenRouter's OpenAI-compatible endpoint;
- `z-ai/glm-5.3-flash`;
- CGC 0.5.7 context;
- sequential execution.

Run at least five repetitions to make the SLO gate eligible:

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

The warm-index target is p95 at or below 10 minutes. The cold-index target is p95 at or below 15 minutes. A target cannot pass unless all live runs pass the quality gate.

## Measurements

Each report contains:

- review wall time and summed model duration;
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
