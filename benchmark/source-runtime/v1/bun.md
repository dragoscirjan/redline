# TypeScript source runtime benchmark

- Runtime: bun 1.4.4
- Captured: 2026-10-24T18:33:20.196Z
- Environment: linux/x64

| Measurement | Runs | Minimum | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| CLI validation startup | 5 | 12 ms | 13 ms | 14 ms | 14 ms |
| Echo review pipeline | 3 | 78 ms | 79 ms | 85 ms | 85 ms |

## Limits

- Local process measurements include operating-system and filesystem noise.
- The echo review measures direct-source bundle and review execution without model or network latency.
- The result does not show that Bun improves model-bound review latency.
