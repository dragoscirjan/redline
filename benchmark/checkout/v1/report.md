# Checkout and exact-revision fetch benchmark

- Status: **complete**
- Profile digest: `c3ea2610a70a62b4c620e7d561e3d839cb08c0e3e6884ac7071aff1fc7e68c7a`
- Capture: 2026-10-25T13:08:45.644Z
- Workflow run: [https://github.com/dragoscirjan/redline/actions/runs/40194071271](https://github.com/dragoscirjan/redline/actions/runs/40194071271)
- Environment: Linux/x64; git version 2.55.0; Node v24.21.0
- Decision: **retain-full** — Full checkout is retained because shallow and partial changed authoritative output on at least one repository.

## Pinned repositories

| Corpus | Size | Repository | Base | Head |
| --- | --- | --- | --- | --- |
| Redline | small | `dragoscirjan/redline` | `03a4578c8db5` | `739bc3d3e51f` |
| Microsoft Visual Studio Code | large | `microsoft/vscode` | `e4c1bc2b7853` | `86db3b69224f` |

## Stage timings (nearest-rank p50 / p95)

| Repository | Strategy | Equivalent | Checkout | Exact fetch | Object hydration | Bundle | Index source export | Critical path |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| redline-small | full | yes | 539 ms / 593 ms | 559 ms / 597 ms | 2 ms / 18 ms | 352 ms / 367 ms | 69 ms / 71 ms | 1,520 ms / 1,598 ms |
| redline-small | shallow | yes | 519 ms / 570 ms | 1,706 ms / 1,872 ms | 2 ms / 8 ms | 355 ms / 361 ms | 71 ms / 72 ms | 2,648 ms / 2,864 ms |
| redline-small | partial | yes | 815 ms / 895 ms | 336 ms / 455 ms | 542 ms / 696 ms | 353 ms / 358 ms | 69 ms / 70 ms | 2,112 ms / 2,467 ms |
| vscode-large | full | yes | 60,043 ms / 66,072 ms | 73,033 ms / 73,603 ms | 0 ms / 147 ms | 3,144 ms / 3,200 ms | 4,523 ms / 4,634 ms | 141,015 ms / 146,676 ms |
| vscode-large | shallow | no | 9,099 ms / 9,342 ms | 19,883 ms / 20,372 ms | 0 ms / 54 ms | 3,019 ms / 3,488 ms | 4,317 ms / 4,563 ms | 36,181 ms / 37,245 ms |
| vscode-large | partial | no | 25,038 ms / 25,902 ms | 22,774 ms / 22,946 ms | 4,695 ms / 5,067 ms | 3,127 ms / 3,506 ms | 4,307 ms / 4,478 ms | 60,003 ms / 61,240 ms |

## Local Git object-store bytes (nearest-rank p50 / p95)

| Repository | Strategy | After checkout | Added by exact fetch | Added by index source | Added by bundle | Final |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| redline-small | full | 1.7 MiB / 1.7 MiB | 1.8 MiB / 1.8 MiB | 0.0 MiB / 0.0 MiB | 0.0 MiB / 0.0 MiB | 3.5 MiB / 3.5 MiB |
| redline-small | shallow | 0.7 MiB / 0.7 MiB | 1.5 MiB / 1.5 MiB | 0.0 MiB / 0.0 MiB | 0.0 MiB / 0.0 MiB | 2.2 MiB / 2.2 MiB |
| redline-small | partial | 1.0 MiB / 1.0 MiB | 0.3 MiB / 0.3 MiB | 0.1 MiB / 0.1 MiB | 0.1 MiB / 0.1 MiB | 1.5 MiB / 1.5 MiB |
| vscode-large | full | 1449.9 MiB / 1450.4 MiB | 1450.9 MiB / 1450.9 MiB | 0.0 MiB / 0.0 MiB | 0.0 MiB / 0.0 MiB | 2900.9 MiB / 2901.4 MiB |
| vscode-large | shallow | 68.6 MiB / 68.6 MiB | 149.4 MiB / 149.4 MiB | 0.0 MiB / 0.0 MiB | 0.0 MiB / 0.0 MiB | 217.9 MiB / 217.9 MiB |
| vscode-large | partial | 378.9 MiB / 378.9 MiB | 309.1 MiB / 309.8 MiB | 2.4 MiB / 2.4 MiB | 1.0 MiB / 1.0 MiB | 691.4 MiB / 692.0 MiB |

## Decision gate

- Selected strategy: full
- Fastest strategy: full
- Saved on large repository: 0 ms (0%)
- Material: no
- Rejected strategies: shallow, partial
- Git object cache evaluation: not-eligible

## Limitations

- GitHub-hosted network and server load vary; five nearest-rank samples provide bounded evidence, not a universal latency guarantee.
- The full strategy fetches complete history reachable from the pinned base, which approximates the current fetch-depth-zero path without fetching unrelated branches.
- Object bytes measure the local Git object store after each stage, not wire-level compressed transfer bytes.
- Synthetic repositories prove fork, force-push, merge-commit, and shallow-history correctness; public repositories supply transfer-scale evidence.
- Pull request source remains data: the benchmark invokes Git and trusted Redline tooling only and never runs repository scripts, builds, hooks, or installers.
