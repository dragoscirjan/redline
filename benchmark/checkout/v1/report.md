# Checkout and exact-revision fetch benchmark

- Status: **pending**
- Profile digest: `c3ea2610a70a62b4c620e7d561e3d839cb08c0e3e6884ac7071aff1fc7e68c7a`
- Capture: pending
- Workflow run: pending
- Environment: pending
- Decision: **pending** — The manual GitHub-hosted benchmark must run after this workflow is available on the default branch.

## Pinned repositories

| Corpus | Size | Repository | Base | Head |
| --- | --- | --- | --- | --- |
| Redline | small | `dragoscirjan/redline` | `03a4578c8db5` | `739bc3d3e51f` |
| Microsoft Visual Studio Code | large | `microsoft/vscode` | `e4c1bc2b7853` | `86db3b69224f` |

## Live evidence pending

The benchmark workflow must first merge to the default branch. Then run five GitHub-hosted repetitions for each repository and strategy, retain raw per-run JSON as the workflow artifact, and replace this pending aggregate with the bounded aggregate output.

## Limitations

- GitHub-hosted network and server load vary; five nearest-rank samples provide bounded evidence, not a universal latency guarantee.
- The full strategy fetches complete history reachable from the pinned base, which approximates the current fetch-depth-zero path without fetching unrelated branches.
- Object bytes measure the local Git object store after each stage, not wire-level compressed transfer bytes.
- Synthetic repositories prove fork, force-push, merge-commit, and shallow-history correctness; public repositories supply transfer-scale evidence.
- Pull request source remains data: the benchmark invokes Git and trusted Redline tooling only and never runs repository scripts, builds, hooks, or installers.
