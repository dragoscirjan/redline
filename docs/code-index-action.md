# Code-index action

`github/code-index` is a secondary composite action that prepares bounded code context for an exact pull request head. The published Redline action invokes it before review execution. The review core does not install an indexer, open an index database, or invoke provider commands.

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

## What the action does

1. Acquires and validates the selected pinned provider without using pull-request package files.
2. Restores that provider's exact pull request base-revision database with `actions/cache/restore`.
3. Exports both the exact base and exact head with `git archive`.
4. Removes symlinks and repository-supplied provider configuration from both temporary source trees.
5. Validates and reuses a restored base database without running provider indexing again.
6. On a cache miss or invalid restore, indexes the full exported base repository regardless of whether the changed files use a supported language.
7. Uses supported changed files that exist in the base graph as bounded relationship-query anchors.
8. Resolves every selected path and line range against the exported exact-head source.
9. Writes the provider-neutral bounded artifact atomically.
10. Saves a validated base database only after a cache miss or invalid restore.

Repository builds, scripts, package installers, tests, and Git hooks are never run. GitNexus runs in `--index-only --skip-git --skip-fts` mode against an action-created archive and action-owned storage; repository AI-context files and skills are never generated. The graph is identified by `pull_request.base.sha`, so every new head commit in the same pull request reuses it without re-indexing. If the base revision changes, the action creates a new cache. New head-only files receive explicit partial graph coverage, while every selected span is still re-resolved from captured exact-head source.

## Artifact contract

The version 1 artifact contains:

- provider ID and exact version;
- repository, exact head revision, and the exact base graph revision when graph facts are present;
- top-level coverage status;
- per-changed-file coverage;
- related repository path, one-based line range, and fixed selection reason;
- for each source-resolved provider result, a bounded action-produced graph reference whose digest binds the provider, version, base snapshot, capability, query identity, relationship, and resolution to that exact span;
- bounded diagnostics;
- separate installation, restore, index, query, and save timings.

It contains no graph database, source text, credentials, model conclusions, or finding locations. The strict parser is exported from `src/code-context/artifact.ts`. Limits include 256 changed files, 64 related spans, eight spans per changed file, 80 lines per span, 48 KiB of resolved source coverage, 20 diagnostics, and a 128 KiB artifact.

`complete` means every represented, supported changed file exists in the base graph and was queried within the limits. `partial` records a supported head-only file that is absent from the base graph, any unsupported file mixed with supported coverage, failed query direction, invalid provider row, or truncation. `unsupported` means no changed head file can anchor a provider query. `unavailable` means indexing or validation failed. Empty successful query output is only empty context; it is not proof that no relationship exists.

## Action-owned follow-up (draft #107, gated off)

The trusted root action contains a separate `github/code-index/follow-up.py` worker and a bounded TypeScript adapter. Discovery version 4 may request up to four candidate-indexed `incoming`/`outgoing` relationships per file. Review code first validates the candidate and derives the changed path; it never accepts a model query, symbol, command, provider, or arbitrary file path. The adapter sends only a fixed depth-one, fan-out-eight, result-eight request to the trusted worker. Each request is bounded to 20 seconds, with a 120-second worker deadline and cumulative review-run budgets.

The worker checks the reviewed manifest file, repository, head, provider pin, configuration, exact base cache state, and safe base/head source trees. It generates a fixed provider query, refuses truncated or invalid rows, and attaches an exact-head start-line anchor only when the source is captured and readable. The review core re-resolves that anchor from its separate review bundle; graph labels and empty query results do not establish publication claims. A missing, stale, unsupported, or failed query is an explicit unavailable/incomplete result and may not silently fall back to a guessed source. The review core records `source-disagreement` when a returned span conflicts with captured source, and `source-unavailable` when it cannot read that source. An empty or missing worker result has a different diagnostic from an oversized result. Offline tests exercise both fake providers, stale snapshots, malformed model-controlled requests, provider failures, missing source, and source-backed verifier integration. In the fake-provider benchmark, CGC and GitNexus both return the expected source anchor with `complete` coverage; stale snapshots, failed queries, and missing source return unavailable/partial coverage with **zero** accepted spans. The no-index fallback records required incomplete coverage (`follow-up provider is not configured`) with zero provider calls. Fake-provider durations are locally measured per response under the 20-second request cap, but are not meaningful estimates of either provider's live latency. The live model-only verifier capture had no provider worker and failed its recall/coverage gate; no live CGC/GitNexus follow-up capability or latency has been demonstrated.

This worker is **not** activated in the published action. `CODE_INDEX_VERIFICATION_ENABLED` is hardcoded to `false` pending separately judged live recall, clean-change and latency gates. It never runs when the verifier is disabled.

## Cache keys

The provider-specific key prefixes are:

```text
redline-code-index-v2-cgc-0.5.7-linux-x64-<repository-digest>-<configuration-digest>
redline-code-index-v2-gitnexus-1.6.12-<platform>-<repository-digest>-<configuration-digest>
```

The save key adds the exact base SHA, workflow run ID, and attempt. The only restore prefix includes that same exact base SHA; there is no cross-base or cross-provider fallback. A valid restored database is queried directly, no indexing command runs, and the existing cache is not saved again. The run suffix allows a validated rebuild to supersede an immutable invalid cache entry.

The cache root contains only provider database files, the provider's bounded registry when required, and a small identity sidecar. The action rejects symlinks and non-regular entries and verifies provider version, repository, configuration, exact base revision, stable source path, and a bounded graph query before reuse. A validated base graph is cached even when none of the changed files can anchor a relationship query. Cache restore or save failure does not invalidate context produced during the current run.

## Tests

Normal CI uses fake CGC and GitNexus providers and performs no provider download. It covers cold and restored-base equivalence, no-reindex reuse across head commits, exact-base and provider cache identity, invalid restore rebuilding, bounded queries, source validation, and provider failure fallback.

Live smoke tests are separate opt-ins:

```bash
REDLINE_LIVE_CODE_INDEX_TESTS=1 mise run test
REDLINE_LIVE_GITNEXUS_TESTS=1 mise run test
```

The first downloads pinned CGC. The second runs the trusted pinned GitNexus installer and may take substantially longer because its locked npm dependency tree is acquired for the test.
