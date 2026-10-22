# Live indexer evaluation

- Fixture: `cross-file-cache-collision`
- Provider: CGC 0.5.7, downloaded and checksum-verified by `github/code-index`
- Run: cold, no restored cache, local Linux x64
- Coverage: complete
- Expected related caller found: yes
- Related spans: 1
- Installation: 1,837 ms
- Restore: 40 ms
- Indexing: 7,825 ms
- Query: 18,048 ms
- Save: not run

The pinned provider returned the expected caller, and Redline re-resolved the span from captured exact-head source. The previous partial result was caused by Redline applying its query-output `RLIMIT_FSIZE` to the whole CGC process, which also restricted the provider's embedded database writes. Output is now bounded by the parent process without changing provider file limits.

The timings describe one small local run, not production runner performance. This result demonstrates live provider capability. It does not establish an indexed-context review-quality improvement or satisfy the separate verifier activation gate.
