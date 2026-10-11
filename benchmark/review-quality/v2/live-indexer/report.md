# Live indexer evaluation

- Fixture: `cross-file-cache-collision`
- Provider: CGC 0.5.7, downloaded and checksum-verified by `github/code-index`
- Run: cold, no restored cache, local Linux x64
- Coverage: partial
- Expected related caller found: no
- Related spans: 0
- Diagnostics: `cgc-incoming-query-failed`, `cgc-query-partial`
- Installation: 2,036 ms
- Restore: 67 ms
- Indexing: 8,023 ms
- Query: 18,063 ms
- Save: not run

The provider indexed the fixture but did not complete the bounded incoming relationship query. The timings describe this local run, not production runner performance. This run does not support enabling indexed context in normal workflows. The deterministic comparison remains an ingestion/scoring contract and an upper-bound example of what useful context could change; it is not evidence that CGC currently supplies that context.
