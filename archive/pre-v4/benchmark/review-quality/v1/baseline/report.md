# Review-quality benchmark

## file-only

- Fixtures: 4
- Root-cause recall: 1/2 (50.0%)
- Credited issue recall: 1/2 (50.0%)
- False positives: 1
- Duplicate findings: 0
- Clean fixtures with false positives: 1/2 (50.0%)
- Evidence accuracy for claimed matches: 1/1 (100.0%)
- Total prompt: 31707 bytes
- Recorded review duration: 39 ms

| Fixture | Kind | Coverage | Expected | Root matches | Credited | Findings | False positives | Duplicates | Prompt bytes | Duration ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| clean-api-extension | clean | complete | 0 | 0 | 0 | 1 | 1 | 0 | 7913 | 9 |
| clean-local-refactor | clean | complete | 0 | 0 | 0 | 0 | 0 | 0 | 7902 | 8 |
| cross-file-cache-collision | defect | complete | 1 | 0 | 0 | 0 | 0 | 0 | 7795 | 10 |
| local-port-validation | defect | complete | 1 | 1 | 1 | 1 | 0 | 0 | 8097 | 12 |

## Interpretation

This report evaluates checked-in responses and human judgments. It verifies the fixture, scoring, and reporting contracts without measuring a live model or code indexer.

