---
title: Dogfood reviews
description: How Redline reviews and publishes results on its own pull requests
---

# Dogfood reviews

Redline reviews its own pull requests through `.github/workflows/pr-review.yml`. That workflow calls `.github/workflows/dogfood-review.yml`, which runs the local `./github` action from the pull request's trusted base revision.

## Trigger and trust boundary

The wrapper runs on these `pull_request` events:

- `opened`;
- `synchronize`;
- `reopened`;
- `edited`;
- `ready_for_review`.

The workflow checks out the `github.event.pull_request.base.sha` revision before it calls `./github`. Pull request commits are fetched and processed as data. Redline does not install dependencies from the pull request, run its scripts, or execute its code.

This repository uses `pull_request` because its automatic reviews target same-repository branches, where the configured repository secrets are available. GitHub does not pass those secrets to an untrusted fork event. A fork event therefore takes the context-only path described below.

External repositories must use the [reusable review workflow](/reusable-review-workflow). Its caller uses `pull_request_target` so review and publication secrets are available while the action still treats pull request content only as data. Do not replace that caller with a pull request checkout or execute pull request code.

## Review enablement

The caller maps the repository secret `MODEL_CREDENTIALS` to the reusable workflow's `model-auth` secret. The dogfood workflow sets all three review inputs together:

- `backend`: `pi`;
- `model-config`: OpenRouter with `z-ai/glm-5.3-flash`;
- `model-auth`: the provider-keyed `MODEL_CREDENTIALS` value.

`backend` and `model-config` are non-empty only when `model-auth` is non-empty. This preserves the action's all-or-nothing review-input contract.

When `MODEL_CREDENTIALS` is absent, all three values are empty. The action builds and uploads the bounded context bundle but does not index source, install a harness, call a model, write review output, or publish review comments. A partial review-input set fails validation instead of silently degrading.

Configured dogfood reviews use `defects-and-risks` scope, action-owned indexing, four concurrent per-file calls, bounded `progress` logging, and the Node 24 TypeScript source runtime by default. `full-output` is reserved for explicit diagnostics. The reusable dogfood inputs accept `review-concurrency` from 1 through 8 and `runtime` as `node` or `bun` (pinned to 1.4.4). The action installs the selected fixed harness package as trusted tooling. Pi runs with tools disabled, separate generated configuration and prompt files for every invocation, and only the selected model credential. Artifacts and publication stay in manifest order regardless of completion order. Review eligibility comes from `.redline/review-eligibility.json` at the exact base revision unless trusted workflow JSON overrides it; pull-request head changes cannot suppress their own review.

## Publication credentials

The wrapper prefers the Redline GitHub App:

- `REDLINE_REVIEW_APP_ID` supplies the App id;
- `REDLINE_REVIEW_PRIVATE_KEY` supplies the private key;
- the action mints one installation token for the start/failure notification and a fresh token for final publication.

`GH_TOKEN` is the fallback publication credential. It is an owner-provided PAT, not the Actions `GITHUB_TOKEN`. The harness review step runs without either publication token.

With a publication credential, the action maintains one summary comment and publishes one GitHub review per file that has validated findings. Each finding becomes one bounded inline comment. Re-runs update the managed summary and skip an already published actor-owned review for the same head.

## Artifacts

The artifact base name is:

```text
pull-request-review-<pull-request-number>-<workflow-run-id>
```

Every run uploads `<artifact-name>-context`. It contains the context bundle, captured source at the reviewed head, and bounded provider-neutral indexed context when indexing completed.

A configured review also uploads `<artifact-name>-reviews`. It contains:

- one JSON and one Markdown record per reviewed file;
- `summary.json` and `summary.md` with run counts, per-file outcomes, and every trusted-policy exclusion with its reason;
- `review.json` and `review.md` with synthesized findings, coverage, limitations, and the deterministic verdict.

Configured dogfood reviews also use an automatic PR-scoped GitHub Actions cache for validated per-file `clean` and `findings` results. Unchanged semantic matches skip the model call; changed diffs, requirements, bounded source, or resolved indexed context execute again. The review artifact reports reused files, executed files, invalid cache entries ignored, and estimated model time saved.

The output is not the historical review journal. See [review output](/review-reporting) for the current schemas and [GitHub composite action](/github-composite-action) for the full pipeline.

## Container status

The current action invokes Pi or OpenCode directly through the harness executor. It does not run the harness in Docker or Podman. `container-engine` remains a legacy reusable-workflow input for caller compatibility and is not forwarded to the action. Container sandboxing is a future milestone and must not be presented as implemented behavior.
