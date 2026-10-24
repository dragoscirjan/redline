# CI TypeScript source runtime capture

- Repository: `dragoscirjan/redline`
- Pull request: [#168](https://github.com/dragoscirjan/redline/pull/168)
- Workflow run: [40121913292](https://github.com/dragoscirjan/redline/actions/runs/40121913292)
- Commit: `a9b7d31a20b2bdc1489e019c2714ddbd2f678b19`

| Runtime | CLI startup p50/p95 | Echo review p50/p95 | Composite action | Outcome |
| --- | ---: | ---: | ---: | --- |
| Node 24.21.0 | 145/156 ms | 371/372 ms | 14,097 ms | success |
| Bun 1.4.4 | 16/16 ms | 123/125 ms | 9,771 ms | success |

The composite-action smoke used the deterministic echo harness with indexing disabled. This is one GitHub-hosted runner capture, not a latency distribution, and it does not measure or predict model-bound review latency. Node remains the default.
