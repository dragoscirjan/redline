# Live model evaluation

- Harness: Pi
- Provider: OpenRouter
- Model: `z-ai/glm-5.3-flash`
- Corpus: review-quality v2, four fixtures
- Indexed-context source: checked-in artifact recordings, not a live CGC run
- Per-file timeout: 5 minutes

| Measurement | File only | Indexed context | Delta |
| --- | ---: | ---: | ---: |
| Root-cause recall | 2/2 | 2/2 | 0 |
| Credited issue recall | 2/2 | 2/2 | 0 |
| False positives | 0 | 0 | 0 |
| Duplicate findings | 0 | 0 | 0 |
| Evidence accuracy | 2/2 | 2/2 | 0 |
| Prompt bytes | 31,739 | 32,778 | +1,039 |
| Resolved indexed source | 0 bytes | 216 bytes | +216 bytes |
| Review duration | 101,162 ms | 66,905 ms | -34,257 ms |

Both modes found the cross-account cache collision and the non-integer port defect at accepted changed-line evidence. Neither mode reported a finding on either clean fixture. Indexed context did not improve recall, evidence accuracy, or false positives in this run.

The latency difference is not credited as an improvement. This is one sequential run, file-only executed before indexed context for each fixture, and model-service latency varied substantially between calls. The run was designed to compare quality and prompt size, not establish a latency distribution.

The raw validated capture is in `capture.json`. It contains no selected credential or endpoint. Findings were mapped to the existing expected issue IDs only when their stated root cause and validated changed-line evidence matched the fixture contract.
