---
layout: home
title: Redline
description: AI code reviews for local Git changes and GitHub pull requests.
hero:
  name: Redline
  text: AI code reviews for your Git changes
  tagline: Review local work or automate pull request reviews with Pi or OpenCode and your choice of model. Read findings in the terminal and keep JSON and Markdown reports.
  actions:
    - theme: brand
      text: Get started
      link: /get-started/
    - theme: alt
      text: Set up GitHub Actions
      link: /get-started/github-actions
---

## Quick start

[Install Redline](/get-started/) and [connect Pi or OpenCode to a model](/get-started/configuration). Then run this from a Git repository with a commit and tracked changes. Model reviews send captured source to your selected provider and can incur charges.

```sh
redline review --indexing disabled
```

Read findings and coverage in the terminal, then open `reviews/review.md` in the output directory printed by Redline. `--indexing disabled` keeps the first run independent of optional indexer setup.

## Next steps {#what-do-you-want-to-do}

- [Review staged changes, branches or commits](/commands).
- [Run with Docker](/docker-workers) using the bundled runtimes and harnesses.
- [Understand findings and saved reports](/results).
- [Fix a setup or review failure](/troubleshooting).

## What Redline does

Redline captures your change, reviews eligible files and checks findings against the diff. It does not execute the reviewed code or apply changes. Review suggestions before acting on them.

For planned integrations and upcoming work, see the [roadmap](/roadmap).

## No-key setup check {#the-shortest-safe-trial}

Prefer to check setup before connecting a model? After [installation](/get-started/), run:

```sh
redline review --harness echo --indexing disabled
```

`echo` makes no model request and always returns a clean answer. It checks the workflow, not code quality. The [first-review guide](/get-started/first-review#_3-run-the-safe-review) includes a disposable example.
