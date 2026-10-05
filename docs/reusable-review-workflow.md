# Reusable review workflow

`.github/workflows/code-review.yml` is the reusable workflow for other repositories. Call it from a `pull_request_target` workflow so the review secret is available:

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
      timeout: 30m
    secrets:
      model-auth: ${{ secrets.MODEL_CREDENTIALS }}
```

## Inputs

| Input | Values | Notes |
| --- | --- | --- |
| `backend` | `pi`, `opencode`, `echo` | Review harness. Empty keeps context-bundle-only behavior. |
| `model-config` | JSON | Provider-neutral model configuration. See [runnable review configuration](/runnable-review-configuration). |
| `finding-scope` | `defects`, `defects-and-risks` | Default `defects`. |
| `timeout` | duration | Default `30m`, capped at `360m`. |
| `artifact-name` | name | Default `redline-review-<run id>`. |
| `artifact-retention-days` | 1–90 | Default `45`. |

## Secret

`model-auth` is the provider-keyed credential map, normally bound to repository secret `MODEL_CREDENTIALS`. Only the selected provider's credential reaches the harness; there is no publication token in the current milestone.

## What the run produces

Two artifacts: `<artifact-name>-context` with the review context bundle and source-at-head export, and `<artifact-name>-reviews` with the per-file review records and run summary described in [review output](/review-reporting).

## Calling within Redline itself

Redline's own pull requests use the dogfood workflow (`.github/workflows/pr-review.yml` → `dogfood-review.yml`), which calls the action from the local `./github` path. External repositories must use this reusable workflow or the published action tag, because a local action path resolves against the caller's repository.
