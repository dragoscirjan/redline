# Redline

Initiative 4.0 implementation is in progress under [#234](https://github.com/dragoscirjan/redline/issues/234). Immutable Git capture and context-bundle generation now work. The complete replacement review engine is not implemented.

The local command supports help and status. Review and RPC commands still exit with code `2`. Git capture is currently a module API, not a new CLI command. Model calls, MCP execution, validated findings, review reports and publication remain unimplemented.

## Check the local command

Use the pinned tools and installed dependencies described in [CONTRIBUTING.md](CONTRIBUTING.md). From the isolated worktree root:

```sh
mise run build
mise exec -- node bin/redline.mjs status --json
```

The status reports `phase: "scaffold"` and `review: "not-implemented"`. To check the Bun source path:

```sh
mise exec -- env REDLINE_ENV=bun node bin/redline.mjs status --json
```

These checks do not review a repository or contact a model. Do not publish this scaffold as a completed review product.

## Capture a Git change

`src/revision-source/git.ts` captures committed revisions or staged, unstaged and combined working-tree changes without changing the source repository. It writes an authoritative bundle and bounded source snapshot into a new private directory outside that repository. Existing destinations are rejected.

See [capture usage and limits](docs/capture.md). The module does not execute reviewed code, contact a model or produce a clean-review result.

## Architecture prototypes

`src/application/composition.ts` declares the shared dependency graph. Model drivers, MCP/tools, review policy/validation, artifacts, reporting, publication, RPC/editor clients, observability and later native VCS adapters now have source prototypes with normal application names.

Their callable bodies fail with `Not implemented`. They do not make model calls, publish findings, write reports, send telemetry or activate clients. Existing CLI behavior and working Git capture remain unchanged. No provider SDK or native editor package was added.

Established neutral finding, evidence, synthesis and per-file document contracts are reused. Undecided payloads remain named `unknown` types, not invented schemas or proof of authorization. See the [architecture guide](docs/architecture.md) for the file map, intended flow and remaining decisions.

Effect `4.1.5` is the only added dependency. The existing Vitest version tests Effects directly, without `@effect/vitest` or a test-framework upgrade.

- [Local command and limits](docs/index.md)
- [Git capture](docs/capture.md)
- [Architecture and unfinished work](docs/architecture.md)
- [Contribution rules](CONTRIBUTING.md)
- [Validation requirements](VALIDATION.md)

## Historical implementation

`src.pre-v4/` and `archive/pre-v4/` preserve the preceding implementation and its tests for approved reuse. They are not active runtime fallbacks and must not enter the new package.

## Validation

```sh
mise run validate
```

The gate checks types, active Vitest/Bats tests and the documentation build. Tests exercise real Git capture, unchanged CLI behavior, prototype type/import/failure contracts and offline-installed Node/Bun packages. Structural tests are not implementation or compatibility evidence for the prototypes. A controlled-process test checks capture cancellation and scratch/output cleanup on POSIX. These checks do not prove model/tool-runtime cleanup, live model compatibility, Docker isolation or review quality. Production review and release automation remain parked.
