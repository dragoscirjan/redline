# Review performance benchmark

- **Source:** recorded
- **Corpus:** Representative 20-file pull request (20 files)
- **Execution:** bounded-parallel (4 workers)
- **Harness/model:** pi (openrouter/z-ai/glm-5.3-flash)
- **Index provider:** cgc 0.5.7
- **Runs:** 1
- **Quality gate:** pass

## End-to-end targets

| Condition | Cache | Samples | Index p50 | Index p95 | Total p50 | Total p95 | Maximum | Target | SLO gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| warm-index | restored | 5 | 23.8 s | 25.3 s | 388.4 s | 392.8 s | 392.8 s | 600.0 s | not eligible |
| cold-index | built | 5 | 130.3 s | 242.1 s | 494.7 s | 606.3 s | 606.3 s | 900.0 s | not eligible |

## Production workflow stage medians

| Condition | Checkout/fetch | Runtime setup | Dependency install/build | Harness install | Context bundle | Validation/writing | Publication | Other bounded overhead |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| warm-index | 1.0 s | 0.9 s | 6.9 s | 9.0 s | 0.1 s | 0.1 s | 2.5 s | 5.0 s |
| cold-index | 1.0 s | 0.7 s | 6.2 s | 8.0 s | 0.1 s | 0.2 s | 2.7 s | 5.5 s |

## Index stage medians

| Condition | Provider installation | Cache restore | Index build | Query/export | Cache save |
| --- | ---: | ---: | ---: | ---: | ---: |
| warm-index | 2.2 s | 0.7 s | 0.0 s | 21.1 s | 0.0 s |
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

| Run | Review wall | Total model work | Max active calls | Publication | Full prompt bytes | Focused prompt bytes | Aggregate reduction | Median reduction | Est. input tokens full | Est. input tokens focused | Est. token reduction | Est. output tokens | Omitted | Findings |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 340.0 s | 1208.0 s | 4 | 0.0 s | 486153 | 363937 | 122216 (25.14%) | 2434 (11.73%) | 121552 | 90999 | 30553 | 320 | 0 | 0 |

## Measured benchmark stages

| Run | Context build | Bundle load | Harness prepare | File prepare | Total model work | Validation | Writing | Summary writing | Publication |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 1208.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |

## Per-file prompt volume

| File | Category | Queue wait | Model | First text | Full bytes | Focused bytes | Reduction | Est. tokens full | Est. tokens focused | Output bytes | Outcome |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| src/cache.ts | typescript | 150.0 s | 55.0 s | 0.0 s | 19341 | 18285 | 1056 (5.46%) | 4836 | 4572 | 63 | clean |
| src/auth.ts | typescript | 180.0 s | 70.0 s | 0.0 s | 20321 | 18285 | 2036 (10.02%) | 5081 | 4572 | 63 | clean |
| src/parser.ts | typescript | 115.0 s | 65.0 s | 0.0 s | 21641 | 18300 | 3341 (15.44%) | 5411 | 4576 | 63 | clean |
| src/api.ts | typescript | 180.0 s | 80.0 s | 0.0 s | 22285 | 18282 | 4003 (17.96%) | 5572 | 4571 | 63 | clean |
| src/schema.ts | typescript | 140.0 s | 60.0 s | 0.0 s | 20657 | 18300 | 2357 (11.41%) | 5165 | 4576 | 63 | clean |
| src/large-service.ts | large-source | 0.0 s | 180.0 s | 0.0 s | 58224 | 18380 | 39844 (68.43%) | 14557 | 4596 | 63 | clean |
| src/large-router.ts | large-source | 0.0 s | 150.0 s | 0.0 s | 51500 | 18374 | 33126 (64.32%) | 12876 | 4594 | 63 | clean |
| scripts/check.ts | typescript | 95.0 s | 45.0 s | 0.0 s | 20013 | 18313 | 1700 (8.49%) | 5004 | 4579 | 63 | clean |
| test/cache.test.ts | test | 45.0 s | 50.0 s | 0.0 s | 20841 | 18330 | 2511 (12.05%) | 5211 | 4583 | 63 | clean |
| test/auth.test.ts | test | 55.0 s | 60.0 s | 0.0 s | 21493 | 18324 | 3169 (14.74%) | 5374 | 4582 | 63 | clean |
| test/parser.test.ts | test | 0.0 s | 55.0 s | 0.0 s | 21173 | 18336 | 2837 (13.40%) | 5294 | 4585 | 63 | clean |
| test/schema.test.ts | test | 0.0 s | 45.0 s | 0.0 s | 20517 | 18334 | 2183 (10.64%) | 5130 | 4584 | 63 | clean |
| .github/workflows/ci.yml | configuration | 200.0 s | 30.0 s | 0.0 s | 18701 | 17914 | 787 (4.21%) | 4676 | 4479 | 63 | clean |
| package.json | configuration | 278.0 s | 20.0 s | 0.0 s | 18185 | 17804 | 381 (2.10%) | 4547 | 4452 | 63 | clean |
| tsconfig.json | configuration | 272.0 s | 18.0 s | 0.0 s | 17957 | 17698 | 259 (1.44%) | 4490 | 4425 | 63 | clean |
| README.md | documentation | 260.0 s | 18.0 s | 0.0 s | 19803 | 18254 | 1549 (7.82%) | 4951 | 4564 | 63 | clean |
| docs/review.md | documentation | 230.0 s | 22.0 s | 0.0 s | 20999 | 18290 | 2709 (12.90%) | 5250 | 4573 | 63 | clean |
| docs/api.md | documentation | 252.0 s | 20.0 s | 0.0 s | 20315 | 18269 | 2046 (10.07%) | 5079 | 4568 | 63 | clean |
| benchmark/capture.json | generated-like | 250.0 s | 90.0 s | 0.0 s | 27014 | 17925 | 9089 (33.65%) | 6754 | 4482 | 63 | clean |
| test/fixtures/snapshot.json | generated-like | 205.0 s | 75.0 s | 0.0 s | 25173 | 17940 | 7233 (28.73%) | 6294 | 4486 | 63 | clean |

## Limitations

- Recorded mode uses checked-in model durations, a modeled bounded-worker schedule, and named production workflow timings; it is deterministic fixture evidence, not a live SLO pass.
- Live mode measures the fixed review corpus but combines it with checked-in warm/cold non-review stage samples from production Action runs.
- The benchmark command starts after checkout and runtime installation, so local run-stage fields for those boundaries are null; production profile samples provide them for end-to-end totals.
- Full-file baseline prompts are assembled in a recorded prepass and are excluded from measured review latency; the focused strategy is the executed review path.
- Token counts are four-characters-per-token estimates until the selected harness exposes bounded provider usage.
- Cost is null until the selected harness exposes bounded provider cost metadata.
- The local publication stage uses the forge-neutral service with an in-memory publisher; end-to-end totals use sampled production publication latency.
