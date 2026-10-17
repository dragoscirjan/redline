# Review-quality benchmark

## file-only

- Fixtures: 4
- Root-cause recall: 1/2 (50.0%)
- Credited issue recall: 1/2 (50.0%)
- False positives: 1
- Duplicate findings: 0
- Clean fixtures with false positives: 1/2 (50.0%)
- Evidence accuracy for claimed matches: 1/1 (100.0%)
- Total prompt: 47647 bytes
- Recorded review duration: 39 ms
- Indexed coverage: disabled 4, complete 0, partial 0, unsupported 0, unavailable 0
- Indexed source: 0 bytes across 0 spans in 0 reviewed files
- Recorded index timings: not applicable

| Fixture | Kind | Review coverage | Indexed coverage | Expected | Root matches | Credited | Findings | False positives | Duplicates | Context spans | Context bytes | Prompt bytes | Duration ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| clean-api-extension | clean | complete | disabled | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 11898 | 9 |
| clean-local-refactor | clean | complete | disabled | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11887 | 8 |
| cross-file-cache-collision | defect | complete | disabled | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11780 | 10 |
| local-port-validation | defect | complete | disabled | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 12082 | 12 |

## indexed-context

- Fixtures: 4
- Root-cause recall: 2/2 (100.0%)
- Credited issue recall: 2/2 (100.0%)
- False positives: 0
- Duplicate findings: 0
- Clean fixtures with false positives: 0/2 (0.0%)
- Evidence accuracy for claimed matches: 2/2 (100.0%)
- Total prompt: 48686 bytes
- Recorded review duration: 39 ms
- Indexed coverage: disabled 0, complete 4, partial 0, unsupported 0, unavailable 0
- Indexed source: 216 bytes across 2 spans in 2 reviewed files
- Recorded index timings: install 0 ms, restore 0 ms, index 0 ms, query 0 ms, save n/a

| Fixture | Kind | Review coverage | Indexed coverage | Expected | Root matches | Credited | Findings | False positives | Duplicates | Context spans | Context bytes | Prompt bytes | Duration ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| clean-api-extension | clean | complete | complete | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 103 | 12410 | 9 |
| clean-local-refactor | clean | complete | complete | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11887 | 8 |
| cross-file-cache-collision | defect | complete | complete | 1 | 1 | 1 | 1 | 0 | 0 | 1 | 113 | 12307 | 10 |
| local-port-validation | defect | complete | complete | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 12082 | 12 |

## Comparison

- Root-cause matches: +1
- Credited issues: +1
- False positives: -1
- Duplicate findings: +0
- Prompt bytes: +1039
- Recorded review duration: +0 ms
- Resolved indexed source: +216 bytes

## Interpretation

This report evaluates checked-in responses and human judgments. It verifies the fixture, scoring, and reporting contracts without measuring a live model or code indexer.
