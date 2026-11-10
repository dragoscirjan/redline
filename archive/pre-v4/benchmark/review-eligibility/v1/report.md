# Review eligibility evidence

- Source: [PR #171 run 40132029782](https://github.com/dragoscirjan/redline/actions/runs/40132029782)
- Head: `8677c6be51e3`
- Run: 42 files, 212,026 diff bytes, 1,286,445 ms model work
- Selected default patterns: `benchmark/**/capture.json`

| Class | Pattern | Files | Diff bytes | Estimated input tokens | Model ms | Findings | Recommendation |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| benchmark-capture | `benchmark/**/capture.json` | 1 | 63669 | 15918 | 3987 | 0 | exclude-by-default |
| benchmark-report | `benchmark/**/report.{json,md}` | 2 | 9815 | 2454 | 5067 | 0 | keep-reviewable |
| generated-snapshot | `**/__snapshots__/** or **/*.snap` | 0 | 0 | 0 | 0 | 0 | insufficient-evidence |

## Rationale

- **benchmark-capture:** Observed raw generated data consumed prompt and model budget without findings or rejected candidates.
- **benchmark-report:** The class is review-relevant or lacks enough evidence for a default exclusion.
- **generated-snapshot:** No files in this class were observed in the capture, so no default exclusion is justified.

## Limitations

- The live observation covers one Redline pull request and one model/provider configuration.
- Model duration is scheduling-dependent; diff bytes and estimated input tokens are deterministic for the captured change.
- Generated snapshots were not observed, so snapshot patterns remain configurable rather than enabled by default.
- Benchmark reports remain reviewable because they summarize policy conclusions; only raw capture data is excluded by default.
