# Code-index action

`github/code-index` is a secondary composite action that prepares bounded code context for an exact pull request head. The published Redline action invokes it before review execution. The review core does not install an indexer, open an index database, or invoke provider commands.

The first implementation uses CodeGraphContext (CGC) 0.5.7 with its embedded FalkorDB backend on Linux x64. Its standalone MIT-licensed release binary is pinned by version and SHA-256 digest. Other platforms produce an `unsupported` artifact instead of blocking file-only review.

## Root action integration

Consumers invoke only the published Redline action. A configured review enables indexing by default; `indexing: disabled` is the explicit file-only mode.

```yaml
- name: Run Redline review
  uses: dragoscirjan/redline/github@v1.0.0
  with:
    backend: pi
    model-config: ${{ vars.REDLINE_MODEL_CONFIG }}
    model-auth: ${{ secrets.MODEL_CREDENTIALS }}
    indexing: enabled # default; set disabled for file-only review
```

Inside `github/action.yaml`, the root composite invokes `uses: $/github/code-index` after fetching the exact base and head commits. GitHub.com's `$/` self-repository reference resolves the child action at the root action's exact running commit, so a consumer pinned to a version tag or commit cannot receive a different index action. It also avoids `./`, which would resolve against the consumer's workspace. GitHub Enterprise Server does not support `$/`; it is outside this action's current platform scope.

The child writes `code-context.json` and exposes its absolute path and coverage status to the root action. The root passes that generated path through the internal review environment contract and includes the artifact in the downloadable context bundle. Consuming workflows do not supply a context path or orchestrate a separate index step.

The review validates the artifact identity and resolves every selected span again from its captured exact-head source. Missing, invalid, unsupported, or unavailable context remains file-only review with explicit degraded coverage.

## What the action does

1. Downloads the pinned CGC binary and verifies its SHA-256 digest.
2. Restores a CGC FalkorDB database with `actions/cache/restore`.
3. Exports the entire exact pull request head with `git archive`.
4. Removes symlinks and repository-supplied CGC configuration from the temporary source tree.
5. Indexes the full exported repository, regardless of whether the changed files use a CGC-supported language.
6. Validates a restored database, refreshes it to the head, or deletes and rebuilds it once.
7. Uses supported changed source files only as bounded relationship-query anchors.
8. Resolves every selected path and line range against the exported head source.
9. Writes the bounded artifact atomically.
10. Saves only a validated exact-head database with `actions/cache/save`.

Repository builds, scripts, package installers, tests, and Git hooks are never run. The graph matches the exact pull request head, not the base branch; a compatible earlier cache may be restored, but it is refreshed to the requested head before use.

## Artifact contract

The version 1 artifact contains:

- provider ID and exact version;
- repository and exact head revision;
- top-level coverage status;
- per-changed-file coverage;
- related repository path, one-based line range, and fixed selection reason;
- bounded diagnostics;
- separate installation, restore, index, query, and save timings.

It contains no graph database, source text, credentials, model conclusions, or finding locations. The strict parser is exported from `src/code-context/artifact.ts`. Limits include 256 changed files, 64 related spans, eight spans per changed file, 80 lines per span, 48 KiB of resolved source coverage, 20 diagnostics, and a 128 KiB artifact.

`complete` means every represented, supported head file was queried within the limits. `partial` records any unsupported file mixed with supported coverage, failed query direction, invalid provider row, or truncation. `unsupported` means no changed head file can be indexed. `unavailable` means indexing or validation failed. Empty successful query output is only empty context; it is not proof that no relationship exists.

## Cache keys

The key prefix is:

```text
redline-code-index-v1-cgc-0.5.7-linux-x64-<repository-digest>-<configuration-digest>
```

The save key adds the exact head, workflow run ID, and attempt. Restore prefixes first select the newest database for the exact head, then the newest provider-compatible earlier database. The run suffix allows a validated rebuild to supersede an immutable invalid cache entry.

The cache root contains only the embedded FalkorDB files and a small identity sidecar. The action verifies provider version, repository, configuration, stable source path, and a bounded repository query before reuse. A validated exact-head graph is cached even when none of the changed files can anchor a relationship query; in that case the context artifact remains `unsupported`, but the repository graph can accelerate a later review. Cache restore or save failure does not invalidate context produced during the current run.

## Tests

Normal CI uses a fake CGC executable and performs no provider download. It covers cold and warm equivalence, invalid restore rebuilding, and provider failure fallback. A live smoke test is opt-in:

```bash
REDLINE_LIVE_CODE_INDEX_TESTS=1 mise run test
```

The live test requires an installed CGC executable reporting exactly `CodeGraphContext 0.5.7`.
