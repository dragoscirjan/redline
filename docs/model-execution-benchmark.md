# Model execution benchmark

Redline records the Pi execution-policy comparison under `benchmark/model-execution/v1/`. The checked-in live capture uses `z-ai/glm-5.3-flash` through OpenRouter, the four-fixture review-quality corpus, temperature `0`, and three repetitions per mode. Each mode therefore covers 12 fixture executions.

The benchmark compares:

- thinking levels `off`, `minimal`, and `low` with a 4,096-token output cap;
- `off` with 4,096 and 16,384 output tokens;
- an OpenAI-compatible JSON response-format probe;
- token usage and estimated cost;
- local fresh-process overhead;
- validated finding coverage and expected-issue evidence locations.

## Commands

Regenerate the report from the checked-in capture:

```sh
mise run benchmark:model-execution
```

The historical matrix includes reasoning-off profiles. These remain readable for deterministic replay, but the executor now rejects reasoning-off execution. Do not rerun that live matrix unchanged; a new live comparison must preserve the owner's reasoning decisions. Existing captures are not new measurements under the current policy.

## Recorded result

| Mode | Complete fixtures | Expected issues credited | p95 per-fixture wall time | Output tokens | Estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| `off-4096` | 7/12 | 1/6 | 38,422 ms | 28,917 | $0.017678 |
| `minimal-4096` | 8/12 | 2/6 | 6,433 ms | 6,073 | $0.007792 |
| `low-4096` | 8/12 | 2/6 | 6,304 ms | 5,711 | $0.007057 |
| `off-16384` | **9/12** | **3/6** | 58,859 ms | 23,578 | $0.015161 |
| `off-4096-json` | 8/12 | 2/6 | 32,408 ms | 25,676 | $0.016071 |

No mode introduced a validated false positive. The live provider still omitted files in every mode. Therefore, this capture is not an absolute quality pass. It is a relative policy comparison.

`off-16384` had the best repeated completion and expected-issue credit counts in this historical capture. That result does not authorize disabling reasoning. Current production uses:

- model/provider-default reasoning, without a reasoning-disable override;
- a 16,384-token default output cap; local CLI users can override it with `--max-output-tokens`, and the review environment accepts `REDLINE_MAX_OUTPUT_TOKENS`. The historical benchmark selected a default, not a universal model limit;
- provider-default sampling in production (temperature `0` is a benchmark control only);
- normal JSON text output, not provider-native response formatting.

The JSON response-format probe did not improve coverage and is not portable across all supported OpenAI-compatible endpoints.

## Deadlines and retries

The production action separates two deadlines:

- `timeout`: 4 minutes per file;
- `run-timeout`: 10 minutes for the complete review.

Each harness call receives the lesser of the per-file deadline and the remaining run budget. After the whole-run deadline expires, Redline starts no new model call. Every remaining reviewed file gets a deterministic `run-deadline-exhausted` omission. Summary artifacts record both deadlines, elapsed time, deadline status, and omission count.

Pi's internal retries are disabled. Redline permits one retry only for a classified transient empty provider response or a bounded transient HTTP or transport failure. The retry uses a fresh invocation directory and the same total file deadline. Redline does not retry timeouts, token-budget exhaustion, malformed output, parser failures, or validation failures.

## Process reuse decision

A ten-sample local probe measured fresh Pi process execution at 173 ms p50 and 211 ms p95, including Pi startup, configuration loading, a loopback streamed response, and JSON event extraction.

Fresh processes remain selected because they preserve the current per-file configuration, session, queue, tool, and credential boundary. Pi RPC is not selected because the current protocol does not prove a complete reset of all mutable state between untrusted files. Direct SDK execution is not selected because the production action intentionally installs no project dependencies; adding the SDK would expand the trusted runtime and credential surface without a measured model-bound benefit.

## Artifact safety

The capture stores validated file records and bounded numeric telemetry only. It does not store prompts, source payloads, raw model output, reasoning, credentials, or publication tokens.

This benchmark does not satisfy the epic's live latency gate. Five eligible fixed-corpus SLO runs are still required.
