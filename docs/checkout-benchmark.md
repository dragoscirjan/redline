# Checkout and exact-revision fetch benchmark

Redline reviews an exact pull request base and head. The repository checkout must therefore preserve all Git behavior used by the review pipeline:

- exact base and head objects, including fork heads and force-pushed commits;
- complete `base..head` revision traversal and per-commit patch capture;
- rename-aware and binary-aware diffs;
- context-bundle base-file reads;
- source exports for the review and both code-index revisions.

Issue #127 is evidence-gated. Stage 1 adds the benchmark and correctness tests but does **not** change the production checkout. Stage 2 runs the merged workflow, checks in only its bounded aggregate JSON and Markdown report, and changes production behavior only if the agreed materiality and correctness gates pass.

The current aggregate is at [`benchmark/checkout/v1/report.md`](https://github.com/dragoscirjan/redline/blob/main/benchmark/checkout/v1/report.md). It remains pending until the manual workflow is available on the default branch.

## Fixed profile

The version-1 profile pins two public repositories and exact revisions:

- Redline as the small repository;
- Microsoft Visual Studio Code as the large repository.

Each strategy runs five times on a GitHub-hosted Ubuntu runner. The workflow rotates repository and strategy order between repetitions to reduce fixed ordering bias.

The strategies are:

1. **Full** — fetch all history reachable from the exact base, materialize the base worktree, then fetch the exact head.
2. **Shallow exact-revision** — fetch the exact base at depth one, fetch the exact head at depth one, and deepen only until the base-to-head history is connected.
3. **Blobless partial** — fetch complete commit and tree history with `blob:none`; checkout and authoritative Git operations hydrate required blobs.

The benchmark does not use a Git object cache. Cache measurement becomes eligible only if the uncached result saves at least 30 seconds and at least 5% of the measured critical path.

## Timing boundaries

Every sample reports these stages separately:

- checkout of the exact base, including its initial fetch and worktree materialization;
- exact base/head fetch;
- estimated object-hydration time, calculated from cold and warm authoritative operations;
- warm context-bundle generation with its review head-source export;
- warm base/head code-index source export;
- the cold critical path used for the optimization decision;
- local Git object-store bytes after each stage.

The aggregate records minimum, nearest-rank p50, nearest-rank p95, and maximum values. The Markdown report presents p50/p95 pairs. Object-store bytes are not wire-level compressed transfer bytes. The report states this limit explicitly.

The benchmark runs the context bundle twice and exports both index source trees twice. The first operation can hydrate missing objects. The second operation supplies the warm execution baseline. The production-shaped critical path uses the first, cold duration; duplicate warm executions exist only to separate execution cost from hydration cost.

## Correctness gates

Every strategy must produce byte-equivalent SHA-256 digests for:

- the complete context bundle;
- the review head-source export;
- the sanitized base source export;
- the sanitized head source export;
- the ordered `git rev-list base..head` output.

Deterministic local fixtures cover:

- merge commits;
- shallow history deepening;
- separate base and fork remotes;
- a force-pushed branch whose reviewed head remains reachable only by its exact commit.

A digest mismatch rejects that strategy. A mismatch among repeated full-checkout samples invalidates the capture because the reference itself is unstable. Rejected strategies cannot satisfy the materiality gate or make Git object caching eligible.

## Decision policy

The report first finds the fastest correct strategy on the large repository. It then chooses the simplest correct strategy within 10% of that result, in this order:

1. full;
2. shallow exact-revision;
3. blobless partial.

A non-full strategy is only a production candidate when it saves at least 30,000 ms **and** 5% of the full strategy's nearest-rank p95 critical path. Otherwise Redline retains the current full-history behavior.

This benchmark does not establish the epic's model-review SLO. It only decides whether checkout and exact-revision Git work are material enough to optimize.

## Run the benchmark

The live measurement is intentionally manual because it performs repeated public network fetches, including five full-history Visual Studio Code fetches.

1. Open **Actions → Checkout benchmark**.
2. Run the workflow from the default branch.
3. Download `checkout-benchmark-<run-id>`.
4. Keep `raw/*.json` in the workflow artifact only.
5. Copy `aggregate.json` and `report.md` into `benchmark/checkout/v1/` in the stage-2 change.
6. Run `mise run benchmark:checkout` and `mise run validate`.

The deterministic CI task only validates the profile/aggregate identity and regenerates the checked-in Markdown. Ordinary CI does not perform the live fetch benchmark.

## Security boundary

The benchmark treats fetched repository content as data. It invokes argument-array Git commands and trusted Redline TypeScript only. It disables Git hooks and ambient Git configuration, does not initialize submodules, and never runs fetched scripts, builds, package installers, filters, or test commands.
