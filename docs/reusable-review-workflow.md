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
      credential-isolation: direct
      container-engine: docker
      timeout: 30m
    secrets:
      github-token: ${{ secrets.GH_TOKEN }}
      model-auth: ${{ secrets.MODEL_CREDENTIALS }}
```

## Enabling and disabling review execution

Review execution is enabled only when `backend` and `model-config` are supplied together with a non-empty `model-auth` secret. To run context-only instead, leave **all three** empty together — a partial set (for example a cleared `backend` next to a set `model-config`) is rejected rather than degraded.

In context-only mode the workflow uploads only the `<artifact-name>-context` artifact with the review context bundle and the source-at-head export. The `<artifact-name>-reviews` artifact with per-file review records is produced only when review execution is enabled.

## Inputs

| Input | Values | Notes |
| --- | --- | --- |
| `backend` | `pi`, `opencode`, `echo` | Review harness. Empty (with `model-config` and `model-auth`) keeps context-only behavior. |
| `model-config` | JSON | Provider-neutral model configuration. See [runnable review configuration](/runnable-review-configuration). |
| `finding-scope` | `defects`, `defects-and-risks` | Default `defects`. |
| `timeout` | duration | Default `30m`, capped at `360m`. |
| `verbosity` | `silent`, `progress`, `full-output` | Live model stream in the run log. Default `progress` (dots). |
| `artifact-name` | name | Default `redline-review-<run id>`. |
| `artifact-retention-days` | 1–90 | Default `45`. |
| `report-style`, `credential-isolation`, `container-engine` | legacy | Surface kept while the published `v1` tag still carries the previous action design, whose review mode requires `credential-isolation: direct` and a `container-engine`. The current action ignores them. |

## Secrets

- `model-auth` — the provider-keyed credential map, normally bound to repository secret `MODEL_CREDENTIALS`. Only the selected provider's credential reaches the harness; it never appears in prompts, logs, or persisted output.
- `github-token` — bound to `secrets.GH_TOKEN`. The current action uses it for publication (one review per file with findings plus a managed summary); supply it whenever reviews should be published, not only as artifacts. A PAT works as-is; a GitHub App installation token posts as `<app-slug>[bot]` and its bot login must be configured on the publisher. Publication never uses the Actions `GITHUB_TOKEN`.

## What the run produces

Two artifacts: `<artifact-name>-context` with the review context bundle and source-at-head export, and `<artifact-name>-reviews` with the per-file review records and run summary described in [review output](/review-reporting) (the latter only when review execution is enabled). When `github-token` is supplied, publication adds one review per file with findings and a managed summary comment to the pull request; see [publication](/github-composite-action#publication).

## Calling within Redline itself

Redline's own pull requests use the dogfood workflow (`.github/workflows/pr-review.yml` → `dogfood-review.yml`), which calls the action from the local `./github` path at the trusted base revision. External repositories must use this reusable workflow or the published action tag, because a local action path resolves against the caller's repository.