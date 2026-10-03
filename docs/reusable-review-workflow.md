# Reusable review workflow

`.github/workflows/code-review.yml` is a reusable workflow that other repositories call to run a Redline review on their pull requests. It passes the caller's inputs and secrets to the published Redline composite action.

## Caller workflow

Add this to the repository under review:

```yaml
name: Pull request review

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

permissions: {}

concurrency:
  group: redline-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    uses: dragoscirjan/redline/.github/workflows/code-review.yml@v1
    with:
      backend: pi
      model-config: >-
        {"provider":"openrouter","endpoint":"https://openrouter.ai/api/v1","model":"provider/model-name"}
      credential-isolation: direct
    secrets:
      github-token: ${{ secrets.GH_TOKEN }}
      model-auth: ${{ secrets.MODEL_CREDENTIALS }}
```

## Why `pull_request_target`

Publication and model secrets are available only to `pull_request_target` runs and to workflows the repository owner defines. A plain `pull_request` run from a fork cannot read `secrets.GH_TOKEN` or `secrets.MODEL_CREDENTIALS`, so the review could not publish findings or reach the model endpoint.

`pull_request_target` grants secrets on untrusted pull request events, which makes the checkout rule critical: the workflow checks out only the caller repository's base revision. It never checks out pull request code. The Redline action fetches the pull request's base and head commits as Git data and reviews that content without executing any of it. Reviewer-supplied text (pull request title and body) enters the review as a requirements file and as bounded prompt data, never as instructions to the harness.

## Inputs

The reusable workflow forwards the [composite action contract](github-composite-action.md):

| Input | Values | Default |
| --- | --- | --- |
| `backend` | `pi` or `opencode`; also selects the pinned runner image | none |
| `model-config` | JSON object with `provider`, `endpoint`, `model` | none |
| `finding-scope` | `defects` or `defects-and-risks` | `defects` |
| `report-style` | `single-block` or `inline` | `single-block` |
| `timeout` | duration string, for example `10m`, `2h`, `1h30m` | `30m` |
| `credential-isolation` | `direct`, required explicitly in review mode | none |
| `container-engine` | `podman` or `docker` | `podman` |
| `artifact-name` | bounded artifact name | `redline-review-<run id>` |
| `artifact-retention-days` | integer from 1 to 90 | `45` |

Review execution starts when `backend`, `model-config`, and `model-auth` are all supplied. The runner image is resolved from the committed backend-to-digest table by the selected backend; callers never choose an image. Without the review inputs the workflow produces the context bundle only.

## Secrets

The reusable workflow declares two secrets and maps them onto the composite action's secret-bound inputs:

- `github-token`: the caller's publication token. Bind `secrets.GH_TOKEN`. Required when review execution is enabled; publication needs `pull-requests: write` and `issues: write` on the caller's token.
- `model-auth`: the provider-keyed credential map. Bind `secrets.MODEL_CREDENTIALS`. The full map stays host-side; only the selected provider credential reaches the container bootstrap channel.

## Version pinning

`@v1` is the moving major alias that the guarded release workflow advances after each validated release. It always resolves to the latest validated stable release within major version 1. The release runbook keeps full-version tags (`v1.2.3`) immutable.

Callers that require a permanently fixed revision call the composite action directly with the immutable full-version tag:

```yaml
- uses: dragoscirjan/redline/github@v1.2.3
```

## Activation timing

The reusable workflow calls `dragoscirjan/redline/github@v1`, which does not exist until the first published release (`v1.0.0`). Until that tag exists, invoking the reusable workflow fails. Two earlier options:

- Call the composite action directly from a full commit SHA of a trusted Redline revision.
- Run a local review pipeline in the caller repository without Redline's action.

Redline's own in-repo pipeline (`pr-review.yml` calling `dogfood-review.yml`) keeps the local `./github` path so internal runs work before the first release.

## Required caller permissions

The caller job needs `contents: read` and, for publication, `pull-requests: write` plus `issues: write` (the managed summary posts through the issue-comments endpoint). The reusable workflow requests these on its own job; the caller workflow-level `permissions: {}` block keeps everything else off.

## Concurrency

Both the caller example and the reusable workflow use:

```yaml
concurrency:
  group: redline-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

A new push to the same pull request cancels the previous review run. The review core's stale-head checks already prevent an older run from publishing after synchronization; the concurrency group stops superseded runs earlier and saves runner time.

## Not implemented here

- The credential gateway. `credential-isolation: direct` remains a documented escape hatch.
- Local model-runtime lifecycle. The workflow expects a configured remote or private model endpoint.
