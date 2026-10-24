# Code-index action

`github/code-index` is a secondary composite action that prepares bounded code context or an exact-revision provider cache. The published Redline action invokes it before review execution. The review core does not install an indexer, open an index database, or invoke provider commands.

The action supports two pinned providers:

- **CodeGraphContext (CGC) 0.5.7** with embedded FalkorDB on Linux x64. Its standalone MIT-licensed binary is pinned by version and SHA-256 digest.
- **GitNexus 1.6.12** with LadybugDB on Linux x64 and arm64. Its npm archive and dependency lock are digest-pinned, lifecycle scripts and embeddings are disabled, and required native packages are validated before use. GitNexus is distributed under the PolyForm Noncommercial License 1.0.0; users selecting it are responsible for confirming that their use satisfies that license.

Unsupported platforms produce an `unsupported` artifact instead of blocking file-only review.

## Root action integration

Consumers invoke only the published Redline action. A configured review enables indexing by default with CGC; `indexing: disabled` is the explicit file-only mode. Select GitNexus with `indexing-provider: gitnexus`.

```yaml
- name: Run Redline review
  uses: dragoscirjan/redline/github@v1.0.0
  with:
    backend: pi
    model-config: ${{ vars.REDLINE_MODEL_CONFIG }}
    model-auth: ${{ secrets.MODEL_CREDENTIALS }}
    indexing: enabled # default; set disabled for file-only review
    indexing-provider: cgc # default; or gitnexus
```

Inside `github/action.yaml`, the root composite invokes `uses: $/github/code-index` after fetching the exact base and head commits. GitHub.com's `$/` self-repository reference resolves the child action at the root action's exact running commit, so a consumer pinned to a version tag or commit cannot receive a different index action. It also avoids `./`, which would resolve against the consumer's workspace. GitHub Enterprise Server does not support `$/`; it is outside this action's current platform scope.

The child writes `code-context.json` and exposes its absolute path and coverage status to the root action. The root passes that generated path through the internal review environment contract and includes the artifact in the downloadable context bundle. Consuming workflows select `cgc` or `gitnexus` through `indexing-provider`; they do not supply a context path or provider-internal commands, storage paths, or execution settings.

The review validates the artifact identity and resolves every selected span again from its captured exact-head source. Missing, invalid, unsupported, or unavailable context remains file-only review with explicit degraded coverage.

## Default-branch warmup

`.github/workflows/code-index-warmup.yml` runs after every push to `main`. It checks out that exact trusted revision, then warms CGC and GitNexus with a two-job maximum. Workflow concurrency cancels an older warmup when a newer default-branch revision arrives, so only the newest base continues.

The warmup calls the same secondary action in `warmup` mode with identical base and head revisions. It therefore uses the same provider pin, platform identity, configuration digest, repository digest, database validation, and cache key format as pull-request review. A later pull request based on that revision restores the validated database and records `indexMs: 0`.

Each provider job writes a step summary and uploads `code-context.json`. The summary records the validated hit or save result, cache identity, cache size, index time, and total measured time. Review artifacts record the validated hit diagnostic and index timing, so warmup-to-review hit rates can be calculated from workflow artifacts. Warmup failures fail only the post-push warmup job; they cannot block the merge that already produced the revision. Reviews still degrade to normal cold indexing or file-only coverage when the cache is absent.

The workflow executes only trusted Redline tooling from the default branch. Provider input is an action-created `git archive`; it does not execute indexed source, repository hooks, provider configuration, tests, or package scripts from pull requests.

## What the action does

1. Acquires and validates the selected pinned provider without using pull-request package files.
2. Restores that provider's exact pull request base-revision database with `actions/cache/restore`.
3. Exports both the exact base and exact head with `git archive`.
4. Removes symlinks and repository-supplied provider configuration from both temporary source trees.
5. Validates and reuses a restored base database without running provider indexing again.
6. On a cache miss or invalid restore, indexes the full exported base repository when at least one changed file can use graph context.
7. In `warmup` mode, indexes the exact default-branch revision even though base and head are identical.
8. In review mode, returns explicit unsupported or partial context without cold indexing when no changed file can anchor a query.
9. Uses supported changed files that exist in the base graph as bounded relationship-query anchors.
10. Resolves every selected path and line range against the exported exact-head source.
11. Writes the provider-neutral bounded artifact atomically.
12. Saves a validated base database only after a cache miss or invalid restore.

The indexed repository's builds, scripts, package installers, tests, and Git hooks are never run. The warmup workflow builds only trusted Redline tooling from the default branch when the GitNexus installer is required. GitNexus runs in `--index-only --skip-git --skip-fts` mode against an action-created archive and action-owned storage; repository AI-context files and skills are never generated. The graph is identified by `pull_request.base.sha`, so every new head commit in the same pull request reuses it without re-indexing. If the base revision changes, the action creates a new cache. New head-only files receive explicit partial graph coverage, while every selected span is still re-resolved from captured exact-head source.

## Artifact contract

The version 1 artifact contains:

- provider ID and exact version;
- repository, exact head revision, and the exact base graph revision when a validated database exists;
- top-level coverage status;
- per-changed-file coverage;
- related repository path, one-based line range, and fixed selection reason;
- for each source-resolved provider result, a bounded action-produced graph reference whose digest binds the provider, version, base snapshot, capability, query identity, relationship, and resolution to that exact span;
- bounded diagnostics;
- separate installation, restore, index, query, and save timings.

It contains no graph database, source text, credentials, model conclusions, or finding locations. The strict parser is exported from `src/code-context/artifact.ts`. Limits include 256 changed files, 64 related spans, eight spans per changed file, 80 lines per span, 48 KiB of resolved source coverage, 20 diagnostics, and a 128 KiB artifact.

`complete` means every represented, supported changed file exists in the base graph and was queried within the limits. `partial` records a supported head-only file that is absent from the base graph, any unsupported file mixed with supported coverage, failed query direction, invalid provider row, or truncation. `unsupported` means no changed head file can anchor a provider query. `unavailable` means indexing or validation failed. Empty successful query output is only empty context; it is not proof that no relationship exists.

## Action-owned follow-up (gated off)

The trusted root action contains a separate `github/code-index/follow-up.py` worker and a bounded TypeScript adapter. Discovery version 4 may request up to four candidate-indexed `incoming`/`outgoing` relationships per file. Review code first validates the candidate and derives the changed path; it never accepts a model query, symbol, command, provider, or arbitrary file path. The adapter sends only a fixed depth-one, fan-out-eight, result-eight request to the trusted worker. Each request is bounded to 20 seconds, with a 120-second worker deadline and cumulative review-run budgets.

The worker checks the reviewed manifest file, repository, head, provider pin, configuration, exact base cache state, and safe base/head source trees. It generates a fixed provider query, refuses truncated or invalid rows, and attaches an exact-head start-line anchor only when the source is captured and readable. The review core re-resolves that anchor from its separate review bundle; graph labels and empty query results do not establish publication claims. A missing, stale, unsupported, or failed query is an explicit unavailable/incomplete result and may not silently fall back to a guessed source. The review core records `source-disagreement` when a returned span conflicts with captured source, and `source-unavailable` when it cannot read that source. An empty or missing worker result has a different diagnostic from an oversized result.

Offline tests exercise both fake providers, stale snapshots, malformed model-controlled requests, provider failures, missing source, and source-backed verifier integration. Pinned-provider smoke benchmarks also execute five sequential follow-up queries against a small TypeScript fixture. Both providers return one expected, source-confirmed incoming span with complete capability coverage. The observed median/p95-nearest-rank latency was 5,976/6,083 ms for CGC 0.5.7 and 144/153 ms for GitNexus 1.6.12. The no-index fallback makes zero provider calls, returns zero spans, and records required incomplete coverage. These small synthetic samples prove the bounded provider path, not production latency or verifier quality. The checked-in report is at `benchmark/review-quality/follow-up-v1/live-providers/report.md`.

This worker is **not** activated in the published action. `CODE_INDEX_VERIFICATION_ENABLED` is hardcoded to `false` pending separately judged live recall, clean-change and latency gates. It never runs when the verifier is disabled.

## Cache keys

The provider-specific key prefixes are:

```text
redline-code-index-v2-cgc-0.5.7-linux-x64-<repository-digest>-<configuration-digest>
redline-code-index-v2-gitnexus-1.6.12-<platform>-<repository-digest>-<configuration-digest>
```

The save key adds the exact base SHA, workflow run ID, and attempt. The only restore prefix includes that same exact base SHA; there is no cross-base or cross-provider fallback. A valid restored database is queried directly, no indexing command runs, and the existing cache is not saved again. The run suffix allows a validated rebuild to supersede an immutable invalid cache entry.

The cache root contains only provider database files, the provider's bounded registry when required, and a small identity sidecar. The action rejects symlinks and non-regular entries and verifies provider version, repository, configuration, exact base revision, stable source path, and a bounded graph query before reuse. Default-branch warmup prepares caches when a review has no useful query anchor; unsupported-only reviews no longer pay that cold-index cost. Cache restore or save failure does not invalidate context produced during the current run.

## Tests

Normal CI uses fake CGC and GitNexus providers and performs no provider download. It covers cold and restored-base equivalence, exact-base warmup followed by a zero-index review hit, unsupported-only cold-index avoidance, no-reindex reuse across head commits, exact-base and provider cache identity, invalid restore rebuilding, bounded queries, source validation, and provider failure fallback.

Live smoke tests are separate opt-ins:

```bash
REDLINE_LIVE_CODE_INDEX_TESTS=1 mise run test
REDLINE_LIVE_GITNEXUS_TESTS=1 mise run test
```

The first downloads pinned CGC. The second runs the trusted pinned GitNexus installer and may take substantially longer because its locked npm dependency tree is acquired for the test. `mise run benchmark:live-follow-up` runs both fixtures and reports five sequential action-owned follow-up samples per provider.
