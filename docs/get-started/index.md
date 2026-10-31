# Install or run from source

Start with a review that needs no API key. Connect a model after that works.

For pull-request reviews instead, use [GitHub Actions setup](/get-started/github-actions). You do not need the local CLI for that path.

## 1. Check the prerequisites

For the first review, you need:

- Node.js 24;
- Git on your trusted PATH;
- a Git repository with at least one commit.

```sh
node --version
git --version
```

Linux, macOS, and Windows each have native x64 and ARM64 CLI tests. Pi and OpenCode are installed separately when you [connect a model](/get-started/configuration). The safe trial uses neither. It also disables indexing, so it does not need Python or an external indexer.

## 2. Choose how to run Redline

### Install a published npm version

```sh
npm install --global --ignore-scripts @dragoscirjan/redline
redline --help
```

This requires a published package. If npm reports `E404`, publication may not be available yet; use the source checkout below. Do not install the unscoped `redline` package as a substitute.

To select a specific published version, use `@dragoscirjan/redline@VERSION` and replace `VERSION` with its exact version number.

### Use a source checkout

```sh
git clone https://github.com/dragoscirjan/redline.git
cd redline
node bin/redline.mjs --help
```

The CLI runs directly on Node.js 24. You do not need to install development dependencies to run the CLI. Dependency installation is for building the documentation and running development tests.

When reviewing another repository, stay in the Redline checkout and select the target explicitly:

```sh
node bin/redline.mjs review --repository /path/to/your/repository --harness echo --indexing disabled
```

Replace `/path/to/your/repository` with an existing Git repository. Paths with spaces need quotes.

## 3. Run your first review

Follow [Run your first review](/get-started/first-review) for a disposable example with an expected result. It makes no model request and does not change the reviewed files.

After that, [connect Pi or OpenCode to a model](/get-started/configuration), then use the [command recipes](/commands) in your own repository.
