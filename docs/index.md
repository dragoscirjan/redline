---
title: Redline
description: Automated pull request review for GitHub, Forgejo, and Gitea
---

# Redline

Automated pull request review, smaller and self-hosted. A GitHub Action reviews a pull request's diff with a fixed review policy and publishes one managed summary plus bounded inline comments on GitHub.

## How a review runs

The action fetches the pull request's base and head commits as Git data, builds a bounded context bundle, and runs the Pi or OpenCode backend inside a digest-pinned container. Findings are schema-validated, mapped to the reviewed diff, and published by host-side code. Pull request code is never checked out or executed, and the full credential map never enters the container.

## Start here

- [Reusable review workflow](/reusable-review-workflow) — call Redline from your repository's `pull_request_target` workflow.
- [GitHub composite action](/github-composite-action) — the full input contract, secrets, pipeline, and boundaries.

## How it works under the hood

- [Runnable review configuration](/runnable-review-configuration) — the `model-config` and `model-auth` contract.
- [Container staging](/container-staging) — how the sandbox is staged without host mounts.
- [Review reporting](/review-reporting) — publication, validation, and the managed summary.

## Status

The GitHub entry point is complete. Forgejo and Gitea entry points are planned under the same review core. See [CONTRIBUTING.md](https://github.com/dragoscirjan/redline/blob/main/CONTRIBUTING.md) for the development workflow and the GitHub issue tracker for open work.