# Code-index value and provider comparison

Captured at 2026-10-24T17:27:38Z. Percentiles use nearest rank. Each local cold/warm cell contains three runs.

## two-file-typescript

Changed TypeScript cache-key function with one source-confirmed caller.

| Provider | Path | Statuses | Cache hits | Supported files p50/p95 | Files with spans p50/p95 | Spans p50/p95 | Source bytes p50/p95 | Install p50/p95 | Restore p50/p95 | Validate p50/p95 | Index p50/p95 | Query p50/p95 | Wall p50/p95 | Cache bytes p50/p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cgc 0.5.7 | cold | complete 0, partial 3, unsupported 0, unavailable 0 | 0/3 | 1/1 | 0/0 | 0/0 | 0/0 | 2009/2444 ms | 57/59 ms | 5990/5993 ms | 7674/7875 ms | 11937/11964 ms | 25635/25867 ms | 16621884/16621884 bytes |
| cgc 0.5.7 | warm | complete 0, partial 3, unsupported 0, unavailable 0 | 3/3 | 1/1 | 0/0 | 0/0 | 0/0 | 2005/2282 ms | 60/61 ms | 5998/6104 ms | 0/0 ms | 11939/11940 ms | 17992/18110 ms | 16621884/16621884 bytes |
| gitnexus 1.6.12 | cold | complete 3, partial 0, unsupported 0, unavailable 0 | 0/3 | 1/1 | 1/1 | 1/1 | 113/113 | 5435/5536 ms | 59/60 ms | 139/143 ms | 2818/2867 ms | 293/296 ms | 3311/3380 ms | 2855921/2855921 bytes |
| gitnexus 1.6.12 | warm | complete 3, partial 0, unsupported 0, unavailable 0 | 3/3 | 1/1 | 1/1 | 1/1 | 113/113 | 5602/5657 ms | 61/67 ms | 137/142 ms | 0/0 ms | 294/304 ms | 509/511 ms | 2855921/2855921 bytes |

Warm exact-base restoration removed provider indexing in every valid restored sample.

## redline-typescript

Redline repository with one trusted benchmark-only change to src/review/indexed-context.ts; repository code was not executed.

| Provider | Path | Statuses | Cache hits | Supported files p50/p95 | Files with spans p50/p95 | Spans p50/p95 | Source bytes p50/p95 | Install p50/p95 | Restore p50/p95 | Validate p50/p95 | Index p50/p95 | Query p50/p95 | Wall p50/p95 | Cache bytes p50/p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cgc 0.5.7 | cold | complete 0, partial 3, unsupported 0, unavailable 0 | 0/3 | 1/1 | 0/0 | 0/0 | 0/0 | 2046/2054 ms | 59/60 ms | 6082/6089 ms | 67716/67766 ms | 11960/12054 ms | 85818/85893 ms | 92967228/93069628 bytes |
| cgc 0.5.7 | warm | complete 0, partial 3, unsupported 0, unavailable 0 | 3/3 | 1/1 | 0/0 | 0/0 | 0/0 | 2119/2155 ms | 69/69 ms | 6006/6086 ms | 0/0 ms | 11951/12033 ms | 18103/18123 ms | 92967228/93069628 bytes |
| gitnexus 1.6.12 | cold | complete 3, partial 0, unsupported 0, unavailable 0 | 0/3 | 1/1 | 1/1 | 7/7 | 12950/12950 | 5383/6500 ms | 60/60 ms | 142/144 ms | 7078/7225 ms | 309/314 ms | 7615/7764 ms | 63673133/63673133 bytes |
| gitnexus 1.6.12 | warm | complete 3, partial 0, unsupported 0, unavailable 0 | 3/3 | 1/1 | 1/1 | 7/7 | 12950/12950 | 5611/6047 ms | 60/71 ms | 147/152 ms | 0/0 ms | 310/310 ms | 559/561 ms | 63673133/63673133 bytes |

Warm exact-base restoration removed provider indexing in every valid restored sample.

## Production default-branch warmups

| Provider | Runs | Index p50/p95 | Total p50/p95 | Cache p50/p95 |
| --- | ---: | ---: | ---: | ---: |
| cgc | 3 | 92232/102369 ms | 102108/112698 ms | 92233999/92233999 bytes |
| gitnexus | 3 | 17429/18144 ms | 36278/40569 ms | 63672515/63672515 bytes |

## Bounded follow-up

| Provider | Status | Source-confirmed spans | Latency p50/p95 |
| --- | --- | ---: | ---: |
| cgc | complete | 1 | 5976/6083 ms |
| gitnexus | complete | 1 | 144/153 ms |

## Review-quality value

- Recorded provider-neutral comparison: credited issues 1 → 2; false positives 1 → 0; +1039 prompt bytes; +216 source bytes.
- Historical live-model comparison: credited issues 2 → 2; false positives 0 → 0; +1039 prompt bytes; +216 source bytes.
- Provider capability, model quality, and latency are separate claims. The current live-model capture shows no quality gain.

## Provider and policy decision

- Default provider: cgc; changed: no.
- Independent verification activation: disabled.
- GitNexus was faster and returned complete related spans in these captures, but its PolyForm Noncommercial license is not suitable as an unconditional default. CGC remained partial with zero related spans in every current cold and warm fixture sample. Existing review-quality evidence does not justify a default-provider change or verification activation.

## Limits

- Local provider distributions contain three sequential samples per condition and repository class.
- Production warmups measure exact-base cache creation, not pull-request cache restoration.
- GitNexus is PolyForm Noncommercial 1.0.0 licensed. Users must confirm that their use satisfies the license.
- CGC returned partial context with zero related spans in all current local cold and warm samples because its incoming query failed.
- No indexed-repository code, build, package installer, or Git hook was executed during these measurements.

