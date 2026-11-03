# Set up GitHub pull-request reviews

Run Redline when a pull request opens or changes. Start with downloadable JSON and Markdown reports, then enable GitHub comments when you are ready. You do not need the local CLI for this setup.

You need a model-provider API key and permission to add repository secrets and workflows. Model reviews send captured source to your selected provider and can incur charges.

## Add the model credential secret {#_1-add-the-model-credential-secret}

In the repository's **Settings → Secrets and variables → Actions**, create a secret named `MODEL_CREDENTIALS`. Use a provider-keyed JSON object:

```json
{"openrouter":"YOUR_API_KEY"}
```

Replace the placeholder in GitHub's secret editor. Do not commit the key. The provider name must match the model configuration below.

## Add the workflow {#_2-add-the-caller-workflow}

Create `.github/workflows/review.yml` on your repository's trusted default branch. Replace `YOUR_MODEL_ID` with an available model ID.

::: warning Keep pull-request code unexecuted
This workflow uses `pull_request_target` so review secrets are available. Do not add a checkout of the pull request head, run its scripts or install its dependencies. The pinned Redline workflow reads the change as Git data.
:::

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
    uses: dragoscirjan/redline/.github/workflows/code-review.yml@70c95807ced1a7360f6238cbc78c420c9fb0db50
    with:
      backend: pi
      model-config: '{"provider":"openrouter","endpoint":"https://openrouter.ai/api/v1","model":"YOUR_MODEL_ID"}'
      indexing: disabled
      timeout: 4m
      run-timeout: 10m
    secrets:
      model-auth: ${{ secrets.MODEL_CREDENTIALS }}
```

The workflow pins an exact Redline commit. Review and update that pin when you upgrade. `indexing: disabled` keeps this first run independent of external indexer setup.

## Open or update a pull request {#_3-open-or-update-a-pull-request}

Open the workflow run in **Actions**, check coverage and download the review artifact. Read its Markdown report for findings and JSON files for detailed records.

Check whether all required files completed. No findings with failed or omitted required files is not a complete review. See [Read the results](/results).

## Add GitHub comments later

Once you have inspected artifact output, follow the [publication setup](/github-composite-action#publication) to enable reviews and the managed summary comment. Publication needs a Redline GitHub App installation token or a suitable PAT. The Actions `GITHUB_TOKEN` is not a publication credential.

For model options, indexed context and other inputs, see the [workflow reference](/reusable-review-workflow).
