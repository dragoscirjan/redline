# CI dependency-install capture

- Repository: `dragoscirjan/redline`
- Pull request: [#169](https://github.com/dragoscirjan/redline/pull/169)
- Workflow run: [40125277504](https://github.com/dragoscirjan/redline/actions/runs/40125277504)
- Commit: `0ef21ef8e8bc219f58eb9fc76c38859a97dfc6f4`
- Cache: `redline-pnpm-store-v1`, Node 24, pnpm 10.33.0
- Store size: 119,068,463 bytes (113.55 MiB), below the 512 MiB save bound

## Frozen install

| Cache state | Samples | Minimum | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold exact-key miss | 4 | 1,043 ms | 1,160 ms | 1,489 ms | 1,489 ms |
| Warm exact-key hit | 6 | 504 ms | 546 ms | 1,089 ms | 1,089 ms |

The first parallel attempt produced four misses and two hits because the first completed jobs saved the shared exact key before the remaining jobs restored it. A rerun of the same workflow restored the exact key in all six jobs.

## Review-action critical path

| Runtime | Before #155 | After #155 samples | Observed time removed |
| --- | ---: | ---: | ---: |
| Node 24.21.0 | 14,097 ms | 8,651 ms; 6,712 ms | 5,446–7,385 ms |
| Bun 1.4.4 | 9,771 ms | 4,284 ms; 7,151 ms | 2,620–5,487 ms |

The action samples use the deterministic echo harness with indexing disabled. They show the startup work removed from the review action, not model-bound review latency.

`node_modules` is not cached. This capture does not provide a comparison that proves a net benefit over restoring the 113.55 MiB pnpm store and running the frozen linker.
