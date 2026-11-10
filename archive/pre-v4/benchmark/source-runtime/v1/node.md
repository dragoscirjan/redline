# TypeScript source runtime benchmark

- Runtime: node v24.21.0
- Captured: 2026-10-24T18:33:19.874Z
- Environment: linux/x64

| Measurement | Runs | Minimum | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| CLI validation startup | 5 | 63 ms | 64 ms | 67 ms | 67 ms |
| Echo review pipeline | 3 | 163 ms | 165 ms | 184 ms | 184 ms |

## Limits

- Local process measurements include operating-system and filesystem noise.
- The echo review measures direct-source bundle and review execution without model or network latency.
- The result does not show that Bun improves model-bound review latency.
