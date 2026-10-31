---
layout: home
title: Redline
description: Review Git changes locally or in GitHub Actions with Pi or OpenCode.
hero:
  name: Redline
  text: Review Git changes with Pi or OpenCode
  tagline: Run a local review or review pull requests in GitHub Actions. Read the findings and keep the JSON and Markdown results.
  actions:
    - theme: brand
      text: Get started
      link: /get-started/
    - theme: alt
      text: Find a command
      link: /commands
---

## What do you want to do?

| Goal | Start here |
| --- | --- |
| Install Redline or try the source checkout | [Get started](/get-started/) |
| Check the workflow without an API key | [Run your first review](/get-started/first-review) |
| Review with a real model | [Connect a model](/get-started/configuration) |
| Review staged changes, a branch, or two commits | [Common commands](/commands) |
| Understand findings, coverage, and output files | [Read the results](/results) |
| Review GitHub pull requests | [Set up GitHub Actions](/get-started/github-actions) |
| Fix a setup or review failure | [Troubleshooting](/troubleshooting) |

## The shortest safe trial

From a Git repository with a committed `HEAD` and tracked changes:

```sh
redline review --harness echo --indexing disabled
```

`echo` checks the review workflow without a model, API key, or indexer. It always produces a clean answer, so it does not tell you whether the code has defects. The [first-review guide](/get-started/first-review) includes a disposable example and the source-checkout command.

## What Redline does

Redline captures the selected Git change, reviews eligible files, validates the structure and diff evidence of findings, and writes review artifacts. It does not apply fixes or execute the reviewed repository's code, tests, or installers. Model findings still need human review.

GitHub Actions can also publish validated findings and a managed summary when publication credentials are configured. Other forges, editor integrations, a container sandbox, and managed local model runtimes are not implemented. See the [architecture reference](/portable-architecture) for those boundaries.
