# Reusable review workflow

`.github/workflows/code-review.yml` is the reusable workflow for other repositories. Call it from a `pull_request_target` workflow so the review secrets are available:

```yaml
name: Review
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions: {}

jobs:
  review:
    uses: dragoscirjan/redline/.github/workflows/code-review.yml@v1
    with:
      backend: pi
      model-config: '{"provider":"openrouter","endpoint":"https://openrouter.ai/api/v1","model":"z-ai/glm-5.3-flash"}'
      finding-scope: defects
      indexing: enabled # default; set disabled for file-only review
      indexing-provider: cgc # default; or gitnexus
      credential-isolation: direct
      container-engine: docker
      timeout: 30m
      review-concurrency: 4 # default; valid range 1-8
    secrets:
      github-token: ${{ secrets.GH_TOKEN }}
      model-auth: ${{ secrets.MODEL_CREDENTIALS }}
```

The caller pins the reusable workflow. Inside that workflow, `uses: $/github` resolves the Redline action from the same repository commit as the workflow, so its input contract cannot drift from the selected workflow revision. It does not resolve against the caller's checkout.

## Enabling and disabling review execution

Review execution is enabled only when `backend` and `model-config` are supplied together with a non-empty `model-auth` secret. To run context-only instead, leave **all three** empty together — a partial set (for example a cleared `backend` next to a set `model-config`) is rejected rather than degraded.

Configured reviews build indexed context inside the published Redline action by default. Set `indexing: disabled` for file-only review. The reusable workflow forwards `indexing` and `indexing-provider`; the published action still owns acquisition, provider execution, cache lifecycle, and bounded normalization.

In context-only mode the workflow does not index and uploads only the `<artifact-name>-context` artifact with the review context bundle and the source-at-head export. The `<artifact-name>-reviews` artifact with per-file review records is produced only when review execution is enabled.

## Inputs

| Input | Values | Notes |
| --- | --- | --- |
| `backend` | `pi`, `opencode`, `echo` | Review harness. Empty (with `model-config` and `model-auth`) keeps context-only behavior. |
| `model-config` | JSON | Provider-neutral model configuration. See [runnable review configuration](/runnable-review-configuration). |
| `finding-scope` | `defects`, `defects-and-risks` | Default `defects`. |
| `timeout` | duration | Default `30m`, capped at `360m`. |
| `review-concurrency` | 1–8 | Maximum simultaneous per-file model calls. Default `4`. |
| `verbosity` | `silent`, `progress`, `full-output` | Live model stream in the run log. Default `progress` (dots). |
| `indexing` | `enabled`, `disabled` | Default `enabled`. The published action owns indexing; `disabled` selects file-only review. |
| `indexing-provider` | `cgc`, `gitnexus` | Default `cgc`. GitNexus is PolyForm Noncommercial 1.0.0 licensed; confirm suitability before selecting it. |
| `artifact-name` | name | Default `redline-review-<run id>`. |
| `artifact-retention-days` | 1–90 | Default `45`. |
| `report-style`, `credential-isolation`, `container-engine` | legacy | Accepted at the reusable-workflow boundary for caller compatibility but not forwarded to the current action. |

## Secrets

- `model-auth` — the provider-keyed credential map, normally bound to repository secret `MODEL_CREDENTIALS`. Only the selected provider's credential reaches the harness; it never appears in prompts, logs, or persisted output.
- `github-token` — bound to `secrets.GH_TOKEN`. The current action uses it for publication (one review per file with findings plus a managed summary); supply it whenever reviews should be published, not only as artifacts. Publication never uses the Actions `GITHUB_TOKEN`.
- App publication — for a GitHub App instead of a PAT, pass the App id and private key (PEM) as `github-app-id`/`github-app-private-key`; the action generates the installation token and prefers it over the fallback. Redline's own auto-review does exactly this.

## What the run produces

Two artifacts: `<artifact-name>-context` with the review context bundle, source-at-head export, and bounded `code-context.json` when indexing runs; and `<artifact-name>-reviews` with the per-file review records and run summary described in [review output](/review-reporting) (the latter only when review execution is enabled). Configured reviews automatically restore and save a PR-scoped cache of fingerprint-matched validated per-file results; cache availability is optional, and the artifact reports reuse counts and estimated time saved. When `github-token` is supplied, publication adds one review per file with findings and a managed summary comment to the pull request; see [publication](/github-composite-action#publication).

## Calling within Redline itself

Redline's own pull requests use the dogfood workflow (`.github/workflows/pr-review.yml` → `dogfood-review.yml`), which calls the action from the local `./github` path at the trusted base revision. External repositories must call this reusable workflow or the published action tag. The reusable workflow uses `$/github` internally so it selects its matching Redline action without depending on the external caller's checkout.