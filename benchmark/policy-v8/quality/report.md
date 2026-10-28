# Review-quality benchmark

## file-only

- Fixtures: 4
- Root-cause recall: 1/2 (50.0%)
- Credited issue recall: 1/2 (50.0%)
- False positives: 1
- Duplicate findings: 0
- Clean fixtures with false positives: 1/2 (50.0%)
- Evidence accuracy for claimed matches: 1/1 (100.0%)
- Focused prompt total: 59237 bytes (~14810 input tokens)
- Full-file baseline total: 57547 bytes (~14387 input tokens)
- Aggregate prompt reduction: -1690 bytes (-2.94%), ~-423 input tokens
- Median per-file prompt reduction: -436.5 bytes (-3.05%)
- Recorded quality maintained across prompt variants: yes
- Recorded review duration: 39 ms
- Indexed coverage: disabled 4, complete 0, partial 0, unsupported 0, unavailable 0
- Indexed source: 0 bytes across 0 spans in 0 reviewed files
- Recorded index timings: not applicable

| Fixture | Kind | Review coverage | Indexed coverage | Expected | Root matches | Credited | Findings | False positives | Duplicates | Context spans | Context bytes | Full bytes | Focused bytes | Reduction | Est. tokens full | Est. tokens focused | Quality held | Duration ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| clean-api-extension | clean | complete | disabled | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 14373 | 14836 | -463 (-3.22%) | 3594 | 3709 | yes | 9 |
| clean-local-refactor | clean | complete | disabled | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 14362 | 14790 | -428 (-2.98%) | 3591 | 3698 | yes | 8 |
| cross-file-cache-collision | defect | complete | disabled | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 14255 | 14700 | -445 (-3.12%) | 3564 | 3675 | yes | 10 |
| local-port-validation | defect | complete | disabled | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 14557 | 14911 | -354 (-2.43%) | 3640 | 3728 | yes | 12 |

## indexed-context

- Fixtures: 4
- Root-cause recall: 2/2 (100.0%)
- Credited issue recall: 2/2 (100.0%)
- False positives: 0
- Duplicate findings: 0
- Clean fixtures with false positives: 0/2 (0.0%)
- Evidence accuracy for claimed matches: 2/2 (100.0%)
- Focused prompt total: 60274 bytes (~15069 input tokens)
- Full-file baseline total: 58586 bytes (~14647 input tokens)
- Aggregate prompt reduction: -1688 bytes (-2.88%), ~-422 input tokens
- Median per-file prompt reduction: -436 bytes (-2.99%)
- Recorded quality maintained across prompt variants: yes
- Recorded review duration: 39 ms
- Indexed coverage: disabled 0, complete 4, partial 0, unsupported 0, unavailable 0
- Indexed source: 216 bytes across 2 spans in 2 reviewed files
- Recorded index timings: install 0 ms, restore 0 ms, validate 0 ms, index 0 ms, query 0 ms, save n/a

| Fixture | Kind | Review coverage | Indexed coverage | Expected | Root matches | Credited | Findings | False positives | Duplicates | Context spans | Context bytes | Full bytes | Focused bytes | Reduction | Est. tokens full | Est. tokens focused | Quality held | Duration ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| clean-api-extension | clean | complete | complete | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 103 | 14885 | 15347 | -462 (-3.10%) | 3722 | 3837 | yes | 9 |
| clean-local-refactor | clean | complete | complete | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 14362 | 14790 | -428 (-2.98%) | 3591 | 3698 | yes | 8 |
| cross-file-cache-collision | defect | complete | complete | 1 | 1 | 1 | 1 | 0 | 0 | 1 | 113 | 14782 | 15226 | -444 (-3.00%) | 3696 | 3807 | yes | 10 |
| local-port-validation | defect | complete | complete | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 14557 | 14911 | -354 (-2.43%) | 3640 | 3728 | yes | 12 |

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
