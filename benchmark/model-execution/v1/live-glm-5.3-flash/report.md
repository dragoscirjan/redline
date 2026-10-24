# Model execution policy benchmark

- Capture: 2026-10-24T20:44:43.935Z
- Harness/model: pi (openrouter/z-ai/glm-5.3-flash)
- Recommendation: `off-16384`

| Mode | Complete | Credits | Findings | False positives | p50 ms | p95 ms | Spawn-call p95 ms | First text p95 ms | Input tokens | Output tokens | Est. cost USD | Retries | Best quality tier |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| off-4096 | 7/12 | 1/6 | 1 | 0 | 14902 | 38422 | 2 | 1296 | 18467 | 28917 | 0.017678 | 0 | no |
| minimal-4096 | 8/12 | 2/6 | 2 | 0 | 2230 | 6433 | 1 | 1309 | 31267 | 6073 | 0.007792 | 0 | no |
| low-4096 | 8/12 | 2/6 | 2 | 0 | 3744 | 6304 | 1 | 989 | 26652 | 5711 | 0.007057 | 0 | no |
| off-16384 | 9/12 | 3/6 | 3 | 0 | 9532 | 58859 | 2 | 1379 | 19744 | 23578 | 0.015161 | 0 | yes |
| off-4096-json | 8/12 | 2/6 | 2 | 0 | 10253 | 32408 | 1 | 25779 | 18586 | 25676 | 0.016071 | 0 | no |

## Recommendation

- Prefer the highest repeated fixture-completion count before considering latency or cost.
- Within that completion tier, require the highest evidence-location credit count with the fewest false positives.
- Among quality-preserving portable modes, prefer lower p95 wall time, then lower estimated cost and output cap.

## Fresh-process overhead

- Successful samples: 10/10.
- End-to-end local p50/p95: 173/211 ms.
- Local time-to-first-text p50/p95: 166/204 ms.

## Deadlines

- Per file: 240000 ms.
- Whole run: 600000 ms.
- Each invocation receives the lesser of the per-file deadline and remaining whole-run time; unstarted files become explicit run-deadline-exhausted omissions.

## Process and provider execution modes

- **fresh-process — selected:** Preserves per-file generated configuration, no-session execution, disabled tools, credential isolation, and deterministic cleanup; the local end-to-end fresh-process probe measured 211 ms p95.
- **rpc-worker — not-selected:** Pi RPC is long-lived, but the current protocol does not prove complete provider, extension, queue, transcript, and credential state reset between untrusted files.
- **direct-sdk — not-selected:** The production action intentionally installs no project dependencies; adding the Pi SDK would expand the trusted runtime and credential surface without measured model-bound benefit.

## Interpretation

- The quality comparison uses Redline-validated findings and credits only findings whose complete validated span falls inside a checked-in expected-issue location.
- `Best quality tier` is relative within this capture. No mode completed all fixtures or credited all expected issues, so this is not an absolute quality pass.
- The JSON response-format mode is a capability probe, not a portable production candidate. OpenAI-compatible endpoints differ in response-format support.
- Token cost is estimated from the capture pricing and Pi usage metadata. Prompts, source, raw output, reasoning, credentials, and publication tokens are not stored in this artifact.
- The report is bounded benchmark evidence. It does not replace the five-run live SLO gate.
