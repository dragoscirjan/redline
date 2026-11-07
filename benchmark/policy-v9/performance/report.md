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
| 1 | 340.0 s | 1208.0 s | 4 | 0.0 s | 462293 | 340077 | 122216 (26.44%) | 2434 (12.45%) | 115590 | 85032 | 30558 | 320 | 0 | 0 |

## Measured benchmark stages

| Run | Context build | Bundle load | Harness prepare | File prepare | Total model work | Validation | Writing | Summary writing | Publication |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 1208.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |

## Per-file prompt volume

| File | Category | Queue wait | Model | First text | Full bytes | Focused bytes | Reduction | Est. tokens full | Est. tokens focused | Output bytes | Outcome |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| src/cache.ts | typescript | 150.0 s | 55.0 s | 0.0 s | 18148 | 17092 | 1056 (5.82%) | 4538 | 4274 | 63 | clean |
| src/auth.ts | typescript | 180.0 s | 70.0 s | 0.0 s | 19128 | 17092 | 2036 (10.64%) | 4783 | 4274 | 63 | clean |
| src/parser.ts | typescript | 115.0 s | 65.0 s | 0.0 s | 20448 | 17107 | 3341 (16.34%) | 5113 | 4277 | 63 | clean |
| src/api.ts | typescript | 180.0 s | 80.0 s | 0.0 s | 21092 | 17089 | 4003 (18.98%) | 5274 | 4273 | 63 | clean |
| src/schema.ts | typescript | 140.0 s | 60.0 s | 0.0 s | 19464 | 17107 | 2357 (12.11%) | 4867 | 4277 | 63 | clean |
| src/large-service.ts | large-source | 0.0 s | 180.0 s | 0.0 s | 57031 | 17187 | 39844 (69.86%) | 14258 | 4297 | 63 | clean |
| src/large-router.ts | large-source | 0.0 s | 150.0 s | 0.0 s | 50307 | 17181 | 33126 (65.85%) | 12577 | 4296 | 63 | clean |
| scripts/check.ts | typescript | 95.0 s | 45.0 s | 0.0 s | 18820 | 17120 | 1700 (9.03%) | 4706 | 4281 | 63 | clean |
| test/cache.test.ts | test | 45.0 s | 50.0 s | 0.0 s | 19648 | 17137 | 2511 (12.78%) | 4913 | 4285 | 63 | clean |
| test/auth.test.ts | test | 55.0 s | 60.0 s | 0.0 s | 20300 | 17131 | 3169 (15.61%) | 5076 | 4283 | 63 | clean |
| test/parser.test.ts | test | 0.0 s | 55.0 s | 0.0 s | 19980 | 17143 | 2837 (14.20%) | 4996 | 4286 | 63 | clean |
| test/schema.test.ts | test | 0.0 s | 45.0 s | 0.0 s | 19324 | 17141 | 2183 (11.30%) | 4832 | 4286 | 63 | clean |
| .github/workflows/ci.yml | configuration | 200.0 s | 30.0 s | 0.0 s | 17508 | 16721 | 787 (4.50%) | 4378 | 4181 | 63 | clean |
| package.json | configuration | 278.0 s | 20.0 s | 0.0 s | 16992 | 16611 | 381 (2.24%) | 4249 | 4153 | 63 | clean |
| tsconfig.json | configuration | 272.0 s | 18.0 s | 0.0 s | 16764 | 16505 | 259 (1.54%) | 4192 | 4127 | 63 | clean |
| README.md | documentation | 260.0 s | 18.0 s | 0.0 s | 18610 | 17061 | 1549 (8.32%) | 4653 | 4266 | 63 | clean |
| docs/review.md | documentation | 230.0 s | 22.0 s | 0.0 s | 19806 | 17097 | 2709 (13.68%) | 4952 | 4275 | 63 | clean |
| docs/api.md | documentation | 252.0 s | 20.0 s | 0.0 s | 19122 | 17076 | 2046 (10.70%) | 4781 | 4270 | 63 | clean |
| benchmark/capture.json | generated-like | 250.0 s | 90.0 s | 0.0 s | 25821 | 16732 | 9089 (35.20%) | 6456 | 4184 | 63 | clean |
| test/fixtures/snapshot.json | generated-like | 205.0 s | 75.0 s | 0.0 s | 23980 | 16747 | 7233 (30.16%) | 5996 | 4187 | 63 | clean |

## Limitations

- Recorded mode uses checked-in model durations, a modeled bounded-worker schedule, and named production workflow timings; it is deterministic fixture evidence, not a live SLO pass.
- Live mode measures the fixed review corpus but combines it with checked-in warm/cold non-review stage samples from production Action runs.
- The benchmark command starts after checkout and runtime installation, so local run-stage fields for those boundaries are null; production profile samples provide them for end-to-end totals.
- Full-file baseline prompts are assembled in a recorded prepass and are excluded from measured review latency; the focused strategy is the executed review path.
- Token counts are four-characters-per-token estimates until the selected harness exposes bounded provider usage.
- Cost is null until the selected harness exposes bounded provider cost metadata.
- The local publication stage uses the forge-neutral service with an in-memory publisher; end-to-end totals use sampled production publication latency.
