# Action-owned follow-up provider benchmark

Captured on 2026-10-22 with the pinned providers on Linux x86_64. The fixture changes a TypeScript cache-key function and asks for one incoming related span. Every accepted span is re-resolved from the captured exact-head source.

| Mode | Capability | Source-confirmed spans | Provider calls | Median | p95 nearest rank |
| --- | --- | ---: | ---: | ---: | ---: |
| CGC 0.5.7 | complete | 1 | 5 | 5,976 ms | 6,083 ms |
| GitNexus 1.6.12 | complete | 1 | 5 | 144 ms | 153 ms |
| No index | unavailable (`not-configured`) | 0 | 0 | 0 ms | 0 ms |

The no-index path records required incomplete follow-up coverage. It does not invoke the configured executor or fabricate graph evidence.

The CGC run exposed a host-integration defect before the successful capture: the query-output size limit was inherited by CGC as `RLIMIT_FSIZE`, which also limited its embedded database writes. Redline now bounds provider stdout in the parent process without changing the provider's file-size limit. A fake-provider regression writes more than the output cap to provider-owned database state while returning a bounded result.

These are five sequential queries against one small synthetic repository. They prove that each pinned provider can return the expected bounded, source-confirmed capability. They do not estimate production latency, prove broad language coverage, or satisfy the separate live verifier activation gate. `CODE_INDEX_VERIFICATION_ENABLED` remains `false`.

Reproduce the provider measurements with:

```bash
mise run benchmark:live-follow-up
```

The deterministic no-index assertion is in `test/runner.integration.test.ts`. Full machine-readable results are in `report.json`.
