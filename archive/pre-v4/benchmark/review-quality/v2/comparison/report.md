# Review-quality benchmark

## file-only

- Fixtures: 4
- Root-cause recall: 1/2 (50.0%)
- Credited issue recall: 1/2 (50.0%)
- False positives: 1
- Duplicate findings: 0
- Clean fixtures with false positives: 1/2 (50.0%)
- Evidence accuracy for claimed matches: 1/1 (100.0%)
- Focused prompt total: 49337 bytes (~12335 input tokens)
- Full-file baseline total: 47647 bytes (~11912 input tokens)
- Aggregate prompt reduction: -1690 bytes (-3.55%), ~-423 input tokens
- Median per-file prompt reduction: -436.5 bytes (-3.69%)
- Recorded quality maintained across prompt variants: yes
- Recorded review duration: 39 ms
- Indexed coverage: disabled 4, complete 0, partial 0, unsupported 0, unavailable 0
- Indexed source: 0 bytes across 0 spans in 0 reviewed files
- Recorded index timings: not applicable

| Fixture | Kind | Review coverage | Indexed coverage | Expected | Root matches | Credited | Findings | False positives | Duplicates | Context spans | Context bytes | Full bytes | Focused bytes | Reduction | Est. tokens full | Est. tokens focused | Quality held | Duration ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| clean-api-extension | clean | complete | disabled | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 11898 | 12361 | -463 (-3.89%) | 2975 | 3091 | yes | 9 |
| clean-local-refactor | clean | complete | disabled | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11887 | 12315 | -428 (-3.60%) | 2972 | 3079 | yes | 8 |
| cross-file-cache-collision | defect | complete | disabled | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11780 | 12225 | -445 (-3.78%) | 2945 | 3057 | yes | 10 |
| local-port-validation | defect | complete | disabled | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 12082 | 12436 | -354 (-2.93%) | 3021 | 3109 | yes | 12 |

## indexed-context

- Fixtures: 4
- Root-cause recall: 2/2 (100.0%)
- Credited issue recall: 2/2 (100.0%)
- False positives: 0
- Duplicate findings: 0
- Clean fixtures with false positives: 0/2 (0.0%)
- Evidence accuracy for claimed matches: 2/2 (100.0%)
- Focused prompt total: 50374 bytes (~12594 input tokens)
- Full-file baseline total: 48686 bytes (~12172 input tokens)
- Aggregate prompt reduction: -1688 bytes (-3.47%), ~-422 input tokens
- Median per-file prompt reduction: -436 bytes (-3.60%)
- Recorded quality maintained across prompt variants: yes
- Recorded review duration: 39 ms
- Indexed coverage: disabled 0, complete 4, partial 0, unsupported 0, unavailable 0
- Indexed source: 216 bytes across 2 spans in 2 reviewed files
- Recorded index timings: install 0 ms, restore 0 ms, validate 0 ms, index 0 ms, query 0 ms, save n/a

| Fixture | Kind | Review coverage | Indexed coverage | Expected | Root matches | Credited | Findings | False positives | Duplicates | Context spans | Context bytes | Full bytes | Focused bytes | Reduction | Est. tokens full | Est. tokens focused | Quality held | Duration ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| clean-api-extension | clean | complete | complete | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 103 | 12410 | 12872 | -462 (-3.72%) | 3103 | 3218 | yes | 9 |
| clean-local-refactor | clean | complete | complete | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11887 | 12315 | -428 (-3.60%) | 2972 | 3079 | yes | 8 |
| cross-file-cache-collision | defect | complete | complete | 1 | 1 | 1 | 1 | 0 | 0 | 1 | 113 | 12307 | 12751 | -444 (-3.61%) | 3077 | 3188 | yes | 10 |
| local-port-validation | defect | complete | complete | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 12082 | 12436 | -354 (-2.93%) | 3021 | 3109 | yes | 12 |

## Comparison

- Root-cause matches: +1
- Credited issues: +1
- False positives: -1
- Duplicate findings: +0
- Prompt bytes: +1037
- Recorded review duration: +0 ms
- Resolved indexed source: +216 bytes

## Interpretation

This report replays the same checked-in responses and human judgments against both prompt-source strategies. It verifies prompt bytes, stable byte-based input-token estimates, fixture scoring, and reporting contracts without measuring a live model or code indexer.
