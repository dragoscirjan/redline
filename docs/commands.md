# Common commands

Run these from the Git repository you want to review. [Configure a model](/get-started/configuration) before a model-based review. The `echo` harness needs no model service or credentials. These commands perform model-based review unless you explicitly select `echo`.

For a source checkout, replace `redline` with `node /path/to/redline/bin/redline.mjs`. Keep the current directory set to the target repository, or select it with `--repository`.

## Review your current changes

```sh
redline review
```

Reviews staged and unstaged tracked changes against `HEAD`. It does not include untracked files or change your index.

## Review only staged changes

```sh
redline review --worktree staged
```

Reviews the exact content you staged with Git, not later edits in the working tree.

## Review only unstaged changes

```sh
redline review --worktree unstaged
```

Compares tracked working files with the index. Already-staged content is the baseline.

## Review your branch against main

```sh
redline review --base origin/main --head HEAD
```

The `origin/main` ref must already exist locally. Update it with your normal Git fetch workflow if needed; Redline does not fetch it. The default comparison starts at the branches' common ancestor. Uncommitted edits do not enter this committed review.

## Review the last commit exactly

```sh
redline review --base HEAD~1 --head HEAD --comparison direct
```

Requires a parent commit. `direct` compares those two trees rather than finding a common ancestor.

## Include new, untracked files

Check for secrets before enabling this. Eligible untracked files can be sent to your model provider. Git-ignored files remain excluded.

```sh
redline review --worktree all --untracked include
```

Untracked files are excluded by default. They cannot be included in a staged-only review.

## Run without an external indexer

```sh
redline review --indexing disabled
```

This skips external provider discovery and execution. Bounded static source relationships can still be included. It does not claim complete call-graph coverage.

If you have installed a supported provider and want missing provider context to stop the run:

```sh
redline review --indexing required
```

See [indexed context](/local-cli#indexed-cross-file-context) for supported versions and platform limitations.

## Give a larger change more time

```sh
redline review --timeout 4m --run-timeout 20m --concurrency 4
```

`timeout` is the initial limit for one file attempt. `run-timeout` is the hard budget for the whole run. The default whole-run budget is 10 minutes; this example explicitly selects 20 minutes.

To allow one additional Redline attempt per file instead of the default three:

```sh
redline review --retries 1
```

Retries still fit within the whole-run budget. OpenCode can make native provider retries inside each attempt. See [retry behavior](/local-cli#review-retries-and-timeouts) before treating attempt counts as HTTP request counts.

## Save output to a chosen directory

From the repository root, choose a new sibling directory:

```sh
redline review --output ../redline-review-001
```

The directory must not exist, its parent must exist, and it must be outside the reviewed repository. Without this flag, Redline creates a private run directory in your user state area. See [Read the results](/results).

## Make findings fail a CI command

```sh
redline review --base origin/main --head HEAD --fail-on high --color never
```

High and critical findings produce exit code `3`. Incomplete coverage or an operational error still fails with code `1`. Findings do not fail the command by default.

For pull-request publication, use the [GitHub workflow](/reusable-review-workflow). The local CLI's `github` reporter is not implemented.

## Check integration without a model

```sh
redline review --harness echo --indexing disabled
```

`echo` always returns a clean answer. Use it to check capture and output, not to judge code quality.

## Find every option

```sh
redline --help
redline review --help
```

The [CLI reference](/local-cli#arguments) explains defaults, configuration precedence, validation, and unsupported capabilities.
