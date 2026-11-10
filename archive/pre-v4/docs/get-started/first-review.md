# Run your first review

Before you start, [install Redline](/get-started/) and [connect a model](/get-started/configuration). You need a Git repository with a commit and tracked changes. Model reviews send captured source to your selected provider and can incur charges.

## Review your changes

Open a terminal in your repository and run:

```sh
redline review --indexing disabled
```

This reviews staged and unstaged tracked changes against `HEAD`. Untracked files are excluded. Redline does not stage, commit or apply changes, and it does not execute your code or tests.

`--indexing disabled` skips optional indexer setup for this first run. You can add [related-code context](/local-cli#indexed-cross-file-context) later.

## Read the result {#_4-check-the-result}

The terminal shows findings, coverage and the output directory. In that directory, open:

- `reviews/review.md` for the consolidated review.
- `reviews/summary.json` for coverage and run details.

Check whether all required files completed, then inspect the findings. No findings with failed or omitted required files is not a complete review. Model suggestions still need your judgment.

See [Read the results](/results) for output files and exit codes.

## Choose a different change

Review only staged changes:

```sh
redline review --worktree staged --indexing disabled
```

Compare your current commit with a local `main` branch:

```sh
redline review --base main --head HEAD --indexing disabled
```

Both refs must already exist locally. See [Common commands](/commands) for other selections, output paths and run settings.

## Optional: check setup without a model {#_3-run-the-safe-review}

The `echo` harness makes no API request and always returns a clean answer. It does not perform model-based code review. Use it to check capture and output before connecting a model.

From a repository with tracked changes:

```sh
redline review --harness echo --indexing disabled
```

Expect completed files, no findings and a printed output directory. Your tracked changes should remain unchanged.

<details>
<summary>Try it in a disposable repository</summary>

### Create a disposable repository {#_1-create-a-disposable-repository}

Choose a new directory outside your projects. If the directory already exists, stop and choose another name. Run these commands only in the new demo directory:

```sh
mkdir redline-demo
cd redline-demo
git init
git config user.name "Redline demo"
git config user.email "redline-demo@example.invalid"
node -e "require('node:fs').writeFileSync('example.ts', 'export const value = 1;\n')"
git add example.ts
git commit --no-gpg-sign -m "Add demo file"
```

The identity settings apply only to this demo repository. `--no-gpg-sign` skips signing for this one commit without changing your signing settings.

### Change the tracked file {#_2-change-the-tracked-file}

```sh
node -e "require('node:fs').writeFileSync('example.ts', 'export const value = 2;\n')"
git status --short
```

Git should show `example.ts` as modified. Run the `echo` command above from this directory. It should complete one required file with no findings. `git status --short` should still show your modified file afterward.

If you use a source checkout, install the locked dependencies and run `pnpm run build` in that checkout first. Then run this from the demo directory, replacing the path with the full path to Redline:

```sh
node /path/to/redline/bin/redline.mjs review --harness echo --indexing disabled
```

Quote the path if it contains spaces. On Windows, use the full Windows path to the checkout.

</details>
