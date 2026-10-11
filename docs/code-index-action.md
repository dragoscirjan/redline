# Code-index action

`github/code-index` is a secondary composite action that prepares bounded code context for an exact pull request head. It runs before the review action. The review core does not install an indexer, open an index database, or invoke provider commands.

The first implementation uses CodeGraphContext (CGC) 0.5.7 with its embedded FalkorDB backend on Linux x64. Its standalone MIT-licensed release binary is pinned by version and SHA-256 digest. Other platforms produce an `unsupported` artifact instead of blocking file-only review.

## Workflow use

The caller checks out trusted workflow tooling with both pull request commits available, then invokes the index action:

```yaml
- name: Prepare bounded code context
  id: code-index
  uses: dragoscirjan/redline/github/code-index@v1.0.0
  with:
    base: ${{ github.event.pull_request.base.sha }}
    head: ${{ github.event.pull_request.head.sha }}
    repository: ${{ github.repository }}
    output-directory: ${{ github.workspace }}/code-index
```

The action writes `code-context.json` and exposes its absolute path and coverage status. Passing that artifact into review is the next bounded-context integration slice; the current review action does not consume it yet.

## What the action does

1. Downloads the pinned CGC binary and verifies its SHA-256 digest.
2. Restores a CGC FalkorDB database with `actions/cache/restore`.
3. Exports the exact head commit with `git archive`.
4. Removes symlinks and repository-supplied CGC configuration from the temporary source tree.
5. Validates a restored database, refreshes it to the head, or deletes and rebuilds it once.
6. Queries incoming and outgoing cross-file call relationships with fixed result and time limits.
7. Resolves every selected path and line range against the exported head source.
8. Writes the bounded artifact atomically.
9. Saves only a validated database with `actions/cache/save`.

Repository builds, scripts, package installers, tests, and Git hooks are never run.

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

The cache root contains only the embedded FalkorDB files and a small identity sidecar. The action verifies provider version, repository, configuration, stable source path, and a bounded repository query before reuse. Cache restore or save failure does not invalidate context produced during the current run.

## Tests

Normal CI uses a fake CGC executable and performs no provider download. It covers cold and warm equivalence, invalid restore rebuilding, and provider failure fallback. A live smoke test is opt-in:

```bash
REDLINE_LIVE_CODE_INDEX_TESTS=1 mise run test
```

The live test requires an installed CGC executable reporting exactly `CodeGraphContext 0.5.7`.
