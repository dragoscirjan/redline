# Get started {#install-or-run-from-source}

Install Redline, connect a model and review your changes. For pull requests, you can go straight to [GitHub Actions setup](/get-started/github-actions) without installing the local CLI.

## Requirements {#_1-check-the-prerequisites}

- Node.js 24 and Git on your trusted PATH.
- A Git repository with at least one commit and changes to review.
- Pi or OpenCode and a model credential, configured in the next step.

```sh
node --version
git --version
```

The local CLI supports Linux, macOS and Windows on x64 and ARM64. If you prefer bundled runtimes and harnesses, use the [Docker guide](/docker-workers).

## Install Redline {#_2-choose-how-to-run-redline}

### Install a published npm version

```sh
npm install --global --ignore-scripts @dragoscirjan/redline
redline --help
```

Use the scoped package `@dragoscirjan/redline`. To choose a published version, append `@VERSION`, replacing `VERSION` with its version number.

## Start a review {#_3-run-your-first-review}

1. [Install Pi or OpenCode and connect a model](/get-started/configuration).
2. [Run your first review](/get-started/first-review).
3. [Read the results](/results) or find a [command for your change](/commands).

No model key yet? The [optional setup check](/get-started/first-review#_3-run-the-safe-review) uses `echo` without a model or indexer. It tests setup, not code quality.

## Use a source checkout

You can run the CLI directly from trusted source instead of installing the npm package:

```sh
git clone https://github.com/dragoscirjan/redline.git
cd redline
node bin/redline.mjs --help
```

Node.js 24 runs the CLI without installing development dependencies. After model setup, select the repository you want to review:

```sh
node bin/redline.mjs review --repository /path/to/your/repository --indexing disabled
```

Replace the path with your repository's full path and quote it if it contains spaces. Development dependencies are needed only to run Redline's tests or build its documentation.
