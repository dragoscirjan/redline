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
| 1 | 340.0 s | 1208.0 s | 4 | 0.0 s | 437973 | 315757 | 122216 (27.90%) | 2434 (13.27%) | 109510 | 78952 | 30558 | 320 | 0 | 0 |

## Measured benchmark stages

| Run | Context build | Bundle load | Harness prepare | File prepare | Total model work | Validation | Writing | Summary writing | Publication |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 1208.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |

## Per-file prompt volume

| File | Category | Queue wait | Model | First text | Full bytes | Focused bytes | Reduction | Est. tokens full | Est. tokens focused | Output bytes | Outcome |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| src/cache.ts | typescript | 150.0 s | 55.0 s | 0.0 s | 16932 | 15876 | 1056 (6.24%) | 4234 | 3970 | 63 | clean |
| src/auth.ts | typescript | 180.0 s | 70.0 s | 0.0 s | 17912 | 15876 | 2036 (11.37%) | 4479 | 3970 | 63 | clean |
| src/parser.ts | typescript | 115.0 s | 65.0 s | 0.0 s | 19232 | 15891 | 3341 (17.37%) | 4809 | 3973 | 63 | clean |
| src/api.ts | typescript | 180.0 s | 80.0 s | 0.0 s | 19876 | 15873 | 4003 (20.14%) | 4970 | 3969 | 63 | clean |
| src/schema.ts | typescript | 140.0 s | 60.0 s | 0.0 s | 18248 | 15891 | 2357 (12.92%) | 4563 | 3973 | 63 | clean |
| src/large-service.ts | large-source | 0.0 s | 180.0 s | 0.0 s | 55815 | 15971 | 39844 (71.39%) | 13954 | 3993 | 63 | clean |
| src/large-router.ts | large-source | 0.0 s | 150.0 s | 0.0 s | 49091 | 15965 | 33126 (67.48%) | 12273 | 3992 | 63 | clean |
| scripts/check.ts | typescript | 95.0 s | 45.0 s | 0.0 s | 17604 | 15904 | 1700 (9.66%) | 4402 | 3977 | 63 | clean |
| test/cache.test.ts | test | 45.0 s | 50.0 s | 0.0 s | 18432 | 15921 | 2511 (13.62%) | 4609 | 3981 | 63 | clean |
| test/auth.test.ts | test | 55.0 s | 60.0 s | 0.0 s | 19084 | 15915 | 3169 (16.61%) | 4772 | 3979 | 63 | clean |
| test/parser.test.ts | test | 0.0 s | 55.0 s | 0.0 s | 18764 | 15927 | 2837 (15.12%) | 4692 | 3982 | 63 | clean |
| test/schema.test.ts | test | 0.0 s | 45.0 s | 0.0 s | 18108 | 15925 | 2183 (12.06%) | 4528 | 3982 | 63 | clean |
| .github/workflows/ci.yml | configuration | 200.0 s | 30.0 s | 0.0 s | 16292 | 15505 | 787 (4.83%) | 4074 | 3877 | 63 | clean |
| package.json | configuration | 278.0 s | 20.0 s | 0.0 s | 15776 | 15395 | 381 (2.42%) | 3945 | 3849 | 63 | clean |
| tsconfig.json | configuration | 272.0 s | 18.0 s | 0.0 s | 15548 | 15289 | 259 (1.67%) | 3888 | 3823 | 63 | clean |
| README.md | documentation | 260.0 s | 18.0 s | 0.0 s | 17394 | 15845 | 1549 (8.91%) | 4349 | 3962 | 63 | clean |
| docs/review.md | documentation | 230.0 s | 22.0 s | 0.0 s | 18590 | 15881 | 2709 (14.57%) | 4648 | 3971 | 63 | clean |
| docs/api.md | documentation | 252.0 s | 20.0 s | 0.0 s | 17906 | 15860 | 2046 (11.43%) | 4477 | 3966 | 63 | clean |
| benchmark/capture.json | generated-like | 250.0 s | 90.0 s | 0.0 s | 24605 | 15516 | 9089 (36.94%) | 6152 | 3880 | 63 | clean |
| test/fixtures/snapshot.json | generated-like | 205.0 s | 75.0 s | 0.0 s | 22764 | 15531 | 7233 (31.77%) | 5692 | 3883 | 63 | clean |

## Limitations

- Recorded mode uses checked-in model durations, a modeled bounded-worker schedule, and named production workflow timings; it is deterministic fixture evidence, not a live SLO pass.
- Live mode measures the fixed review corpus but combines it with checked-in warm/cold non-review stage samples from production Action runs.
- The benchmark command starts after checkout and runtime installation, so local run-stage fields for those boundaries are null; production profile samples provide them for end-to-end totals.
- Full-file baseline prompts are assembled in a recorded prepass and are excluded from measured review latency; the focused strategy is the executed review path.
- Token counts are four-characters-per-token estimates until the selected harness exposes bounded provider usage.
- Cost is null until the selected harness exposes bounded provider cost metadata.
- The local publication stage uses the forge-neutral service with an in-memory publisher; end-to-end totals use sampled production publication latency.

