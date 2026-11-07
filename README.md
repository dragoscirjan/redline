# Redline

AI code reviews for your Git changes. Review local work or pull requests in GitHub Actions with Pi or OpenCode and your choice of model. Read findings in the terminal and keep JSON and Markdown reports.

[Documentation](https://lunaticthinker.me/projects/redline/) · [Get started](docs/get-started/index.md) · [GitHub Actions](docs/get-started/github-actions.md)

## Quick start

Requires Node.js 24 and Git. Install Redline:

```sh
npm install --global --ignore-scripts @dragoscirjan/redline
```

[Install Pi or OpenCode and connect a model](docs/get-started/configuration.md). Then run this from a Git repository with a commit and tracked changes. Model reviews send captured source to your selected provider and can incur charges.

```sh
redline review --indexing disabled
```

Redline prints findings, review coverage and the path to saved reports. Start with `reviews/review.md` in that directory. `--indexing disabled` keeps the first run independent of optional indexer setup.

## Start here

- [Run your first review](docs/get-started/first-review.md), then [read the results](docs/results.md).
- [Find a command](docs/commands.md) for staged changes, branches or commits.
- [Run with Docker](docs/docker-workers.md) to use the bundled runtimes and harnesses.
- [Set up GitHub Actions](docs/get-started/github-actions.md) to review pull requests.
- [Troubleshoot a run](docs/troubleshooting.md).

## How review works

Redline captures the selected change, reviews eligible files and checks findings against the diff. It does not execute the reviewed code, run its tests or apply changes. Review model suggestions before acting on them.

Use the [CLI reference](docs/local-cli.md) for all options, the [JSON-RPC protocol](docs/stdio-protocol.md) for client integrations, and the [architecture reference](docs/portable-architecture.md) for internals.

## Product direction

The goal is one review engine for local changes, forges and editors. Git, the local CLI/RPC and GitHub reviews are available today. Planned integrations and their tracking issues are listed in the [roadmap](docs/roadmap.md).

## Roadmap

See the [project roadmap](docs/roadmap.md) for upcoming work, integration targets and dependencies.

## A safe source-checkout trial

To check setup without a model or API key, use the [optional no-key example](docs/get-started/first-review.md#_3-run-the-safe-review). From a Redline source checkout, install the locked dependencies and build the Node distribution first:

```sh
pnpm install --frozen-lockfile
pnpm run build
node bin/redline.mjs review --repository /path/to/your/repository --harness echo --indexing disabled
```

Replace the path with a Git repository containing a commit and tracked changes. `echo` always returns a clean answer. It checks the workflow, not code quality.

## Development

Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing. See [release operations](docs/local-cli.md#release-operations) for the release workflow.
