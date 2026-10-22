# Review performance benchmark

- **Source:** recorded
- **Corpus:** Representative 20-file pull request (20 files)
- **Execution:** sequential
- **Harness/model:** pi (openrouter/z-ai/glm-5.3-flash)
- **Index provider:** cgc 0.5.7
- **Runs:** 1
- **Quality gate:** pass

## End-to-end targets

| Condition | Cache | Samples | Index p50 | Index p95 | Total p50 | Total p95 | Maximum | Target | SLO gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| warm-index | restored | 3 | 23.7 s | 23.8 s | 1255.7 s | 1256.4 s | 1256.4 s | 600.0 s | not eligible |
| cold-index | built | 5 | 130.3 s | 242.1 s | 1362.7 s | 1474.3 s | 1474.3 s | 900.0 s | not eligible |

## Production workflow stage medians

| Condition | Checkout/fetch | Runtime setup | Dependency install/build | Harness install | Context bundle | Validation/writing | Publication | Other bounded overhead |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| warm-index | 1.0 s | 0.9 s | 6.8 s | 9.0 s | 0.2 s | 0.2 s | 2.3 s | 4.8 s |
| cold-index | 1.0 s | 0.7 s | 6.2 s | 8.0 s | 0.1 s | 0.2 s | 2.7 s | 5.5 s |

## Index stage medians

| Condition | Provider installation | Cache restore | Index build | Query/export | Cache save |
| --- | ---: | ---: | ---: | ---: | ---: |
| warm-index | 2.2 s | 0.7 s | 0.0 s | 20.9 s | 0.0 s |
| cold-index | 2.3 s | 0.4 s | 119.7 s | 0.2 s | 0.0 s |

## Coverage and validity

- Required files per run: 20
- Reviewed records: 20
- Omitted records: 0
- Invalid records: 0
- Findings on clean corpus: 0
- Rejected candidates: 0
- Runs with incomplete required coverage: 0
- Runs with incomplete publication: 0

## Runs

| Run | Review wall | Modeled model time | Publication | Prompt bytes | Estimated input tokens | Estimated output tokens | Omitted | Findings |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1208.0 s | 1208.0 s | 0.0 s | 388473 | 97132 | 320 | 0 | 0 |

## Measured benchmark stages

| Run | Context build | Bundle load | Harness prepare | File prepare | Model | Validation | Writing | Summary writing | Publication |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 1208.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |

## Per-file baseline

| File | Category | Queue wait | Model | First text | Prompt bytes | Output bytes | Outcome |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| src/cache.ts | typescript | 0.0 s | 55.0 s | 0.0 s | 14457 | 63 | clean |
| src/auth.ts | typescript | 55.0 s | 70.0 s | 0.0 s | 15437 | 63 | clean |
| src/parser.ts | typescript | 125.0 s | 65.0 s | 0.0 s | 16757 | 63 | clean |
| src/api.ts | typescript | 190.0 s | 80.0 s | 0.0 s | 17401 | 63 | clean |
| src/schema.ts | typescript | 270.0 s | 60.0 s | 0.0 s | 15773 | 63 | clean |
| src/large-service.ts | large-source | 330.0 s | 180.0 s | 0.0 s | 53340 | 63 | clean |
| src/large-router.ts | large-source | 510.0 s | 150.0 s | 0.0 s | 46616 | 63 | clean |
| scripts/check.ts | typescript | 660.0 s | 45.0 s | 0.0 s | 15129 | 63 | clean |
| test/cache.test.ts | test | 705.0 s | 50.0 s | 0.0 s | 15957 | 63 | clean |
| test/auth.test.ts | test | 755.0 s | 60.0 s | 0.0 s | 16609 | 63 | clean |
| test/parser.test.ts | test | 815.0 s | 55.0 s | 0.0 s | 16289 | 63 | clean |
| test/schema.test.ts | test | 870.0 s | 45.0 s | 0.0 s | 15633 | 63 | clean |
| .github/workflows/ci.yml | configuration | 915.0 s | 30.0 s | 0.0 s | 13817 | 63 | clean |
| package.json | configuration | 945.0 s | 20.0 s | 0.0 s | 13301 | 63 | clean |
| tsconfig.json | configuration | 965.0 s | 18.0 s | 0.0 s | 13073 | 63 | clean |
| README.md | documentation | 983.0 s | 18.0 s | 0.0 s | 14919 | 63 | clean |
| docs/review.md | documentation | 1001.0 s | 22.0 s | 0.0 s | 16115 | 63 | clean |
| docs/api.md | documentation | 1023.0 s | 20.0 s | 0.0 s | 15431 | 63 | clean |
| benchmark/capture.json | generated-like | 1043.0 s | 90.0 s | 0.0 s | 22130 | 63 | clean |
| test/fixtures/snapshot.json | generated-like | 1133.0 s | 75.0 s | 0.0 s | 20289 | 63 | clean |

## Limitations

- Recorded mode uses checked-in model durations and named production workflow timings; it is deterministic fixture evidence, not a live SLO pass.
- Live mode measures the fixed review corpus but combines it with checked-in warm/cold non-review stage samples from production Action runs.
- The benchmark command starts after checkout and runtime installation, so local run-stage fields for those boundaries are null; production profile samples provide them for end-to-end totals.
- Token counts are four-characters-per-token estimates until the selected harness exposes bounded provider usage.
- Cost is null until the selected harness exposes bounded provider cost metadata.
- The local publication stage uses the forge-neutral service with an in-memory publisher; end-to-end totals use sampled production publication latency.

