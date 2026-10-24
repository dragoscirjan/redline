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
| 1 | 340.0 s | 1208.0 s | 4 | 0.0 s | 388473 | 266257 | 122216 (31.46%) | 2434 (15.34%) | 97132 | 66579 | 30553 | 320 | 0 | 0 |

## Measured benchmark stages

| Run | Context build | Bundle load | Harness prepare | File prepare | Total model work | Validation | Writing | Summary writing | Publication |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 1208.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |

## Per-file prompt volume

| File | Category | Queue wait | Model | First text | Full bytes | Focused bytes | Reduction | Est. tokens full | Est. tokens focused | Output bytes | Outcome |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| src/cache.ts | typescript | 150.0 s | 55.0 s | 0.0 s | 14457 | 13401 | 1056 (7.30%) | 3615 | 3351 | 63 | clean |
| src/auth.ts | typescript | 180.0 s | 70.0 s | 0.0 s | 15437 | 13401 | 2036 (13.19%) | 3860 | 3351 | 63 | clean |
| src/parser.ts | typescript | 115.0 s | 65.0 s | 0.0 s | 16757 | 13416 | 3341 (19.94%) | 4190 | 3355 | 63 | clean |
| src/api.ts | typescript | 180.0 s | 80.0 s | 0.0 s | 17401 | 13398 | 4003 (23.00%) | 4351 | 3350 | 63 | clean |
| src/schema.ts | typescript | 140.0 s | 60.0 s | 0.0 s | 15773 | 13416 | 2357 (14.94%) | 3944 | 3355 | 63 | clean |
| src/large-service.ts | large-source | 0.0 s | 180.0 s | 0.0 s | 53340 | 13496 | 39844 (74.70%) | 13336 | 3375 | 63 | clean |
| src/large-router.ts | large-source | 0.0 s | 150.0 s | 0.0 s | 46616 | 13490 | 33126 (71.06%) | 11655 | 3373 | 63 | clean |
| scripts/check.ts | typescript | 95.0 s | 45.0 s | 0.0 s | 15129 | 13429 | 1700 (11.24%) | 3783 | 3358 | 63 | clean |
| test/cache.test.ts | test | 45.0 s | 50.0 s | 0.0 s | 15957 | 13446 | 2511 (15.74%) | 3990 | 3362 | 63 | clean |
| test/auth.test.ts | test | 55.0 s | 60.0 s | 0.0 s | 16609 | 13440 | 3169 (19.08%) | 4153 | 3361 | 63 | clean |
| test/parser.test.ts | test | 0.0 s | 55.0 s | 0.0 s | 16289 | 13452 | 2837 (17.42%) | 4073 | 3364 | 63 | clean |
| test/schema.test.ts | test | 0.0 s | 45.0 s | 0.0 s | 15633 | 13450 | 2183 (13.96%) | 3909 | 3363 | 63 | clean |
| .github/workflows/ci.yml | configuration | 200.0 s | 30.0 s | 0.0 s | 13817 | 13030 | 787 (5.70%) | 3455 | 3258 | 63 | clean |
| package.json | configuration | 278.0 s | 20.0 s | 0.0 s | 13301 | 12920 | 381 (2.86%) | 3326 | 3231 | 63 | clean |
| tsconfig.json | configuration | 272.0 s | 18.0 s | 0.0 s | 13073 | 12814 | 259 (1.98%) | 3269 | 3204 | 63 | clean |
| README.md | documentation | 260.0 s | 18.0 s | 0.0 s | 14919 | 13370 | 1549 (10.38%) | 3730 | 3343 | 63 | clean |
| docs/review.md | documentation | 230.0 s | 22.0 s | 0.0 s | 16115 | 13406 | 2709 (16.81%) | 4029 | 3352 | 63 | clean |
| docs/api.md | documentation | 252.0 s | 20.0 s | 0.0 s | 15431 | 13385 | 2046 (13.26%) | 3858 | 3347 | 63 | clean |
| benchmark/capture.json | generated-like | 250.0 s | 90.0 s | 0.0 s | 22130 | 13041 | 9089 (41.07%) | 5533 | 3261 | 63 | clean |
| test/fixtures/snapshot.json | generated-like | 205.0 s | 75.0 s | 0.0 s | 20289 | 13056 | 7233 (35.65%) | 5073 | 3265 | 63 | clean |

## Limitations

- Recorded mode uses checked-in model durations, a modeled bounded-worker schedule, and named production workflow timings; it is deterministic fixture evidence, not a live SLO pass.
- Live mode measures the fixed review corpus but combines it with checked-in warm/cold non-review stage samples from production Action runs.
- The benchmark command starts after checkout and runtime installation, so local run-stage fields for those boundaries are null; production profile samples provide them for end-to-end totals.
- Full-file baseline prompts are assembled in a recorded prepass and are excluded from measured review latency; the focused strategy is the executed review path.
- Token counts are four-characters-per-token estimates until the selected harness exposes bounded provider usage.
- Cost is null until the selected harness exposes bounded provider cost metadata.
- The local publication stage uses the forge-neutral service with an in-memory publisher; end-to-end totals use sampled production publication latency.

