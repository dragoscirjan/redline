# Set up GitHub pull-request reviews

Use this path to run reviews in GitHub Actions and download their results. It does not require installing the local npm CLI.

## 1. Add the model credential secret

In the repository that will receive reviews, create an Actions secret named `MODEL_CREDENTIALS`. Its value is a provider-keyed JSON object:

```json
{"openrouter":"YOUR_API_KEY"}
```

Replace the placeholder in GitHub's secret editor. Do not commit the key. The provider key must match the model configuration in the next step.

## 2. Add the caller workflow

Create `.github/workflows/review.yml` on your repository's trusted default branch. Replace `YOUR_MODEL_ID` with an available model ID.

This workflow uses `pull_request_target` so credentials are available. Do not add a checkout of the pull request head, run its scripts, or install its dependencies. The pinned Redline workflow handles the change as inert Git data.

```yaml
name: Review pull requests
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions: {}

jobs:
  review:
    permissions:
      contents: read
    uses: dragoscirjan/redline/.github/workflows/code-review.yml@b42f53206aeeccb44d6c429a6130a729b6f46d4a
    with:
      backend: pi
      model-config: '{"provider":"openrouter","endpoint":"https://openrouter.ai/api/v1","model":"YOUR_MODEL_ID"}'
      indexing: disabled
      timeout: 4m
      run-timeout: 10m
    secrets:
      model-auth: ${{ secrets.MODEL_CREDENTIALS }}
```

The example pins a full Redline commit. Review and update that pin when you upgrade. `indexing: disabled` keeps this first setup independent of external indexer provisioning; the [workflow reference](/reusable-review-workflow) covers indexed context.

## 3. Open or update a pull request

The workflow calls the model for eligible changed files and can incur provider charges. In the Actions run, check coverage and download the review artifact. It contains JSON and Markdown results.

No findings does not mean every required file completed. Use [Read the results](/results) to distinguish findings from incomplete coverage.

## Add GitHub comments later

Start with artifact output so you can inspect the results before enabling publication. GitHub reviews and managed comments need a configured publication credential; do not substitute the Actions `GITHUB_TOKEN` for that credential.

See [publication requirements](/github-composite-action#publication) and the [full caller reference](/reusable-review-workflow) for token/App configuration and other inputs. Forgejo, Gitea and other forge integrations are not implemented yet.
