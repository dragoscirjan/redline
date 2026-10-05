---
title: Redline
description: Automated pull request review for GitHub
---

# Redline

Automated pull request review, smaller and self-hosted. A GitHub Action reviews a pull request's changed files with a fixed review policy through a harness executor (Pi or OpenCode), validates every finding against the diff, and publishes the review output as artifacts.

## How a review runs

The action fetches the pull request's base and head commits as Git data, builds a bounded context bundle, and runs one fixed review prompt per changed file through the selected harness. The harness runs with every tool disabled and isolated generated configuration; no ambient credentials reach it. Each model finding must map to a changed line of the authoritative diff with matching evidence, or it is rejected. Pull request code is never executed.

## Start here

- [Reusable review workflow](/reusable-review-workflow) — call Redline from your repository's `pull_request_target` workflow.
- [GitHub composite action](/github-composite-action) — the full input contract, secrets, pipeline, and boundaries.

## How it works under the hood

- [Runnable review configuration](/runnable-review-configuration) — the environment contract, `model-config`, and `model-auth`.
- [Harness executor](/harness-executor) — how Pi and OpenCode are configured and driven, and how to add a harness.
- [Review output](/review-reporting) — per-file review records, validation, and the run summary.

## Status

The GitHub entry point with artifact output is complete. GitHub comment publication, the container sandbox, managed local model runtimes, and Forgejo/Gitea entry points are planned sequenced milestones. See [CONTRIBUTING.md](https://github.com/dragoscirjan/redline/blob/main/CONTRIBUTING.md) for the development workflow and the GitHub issue tracker for open work.
