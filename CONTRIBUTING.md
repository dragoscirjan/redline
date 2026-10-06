# Contributing to Redline

## Set up the repository

Mise installs Node.js 24, Python 3.12, and pnpm 10.33.0. Use pnpm for dependency installation. The pinned pnpm version supports the minimum-release-age, overrides, and ignored-esbuild-installer policy in `pnpm-workspace.yaml`. Do not enable esbuild's installer or change that policy to make setup pass.

```bash
mise trust
mise run deps:sync
```

Run `mise tasks` to list the available tasks. Use `mise run <task>` when a task exists. Dependency installation does not configure Git hooks. Run the validation gate yourself before pushing.

## Development model

Use GitHub Issues for defects, features, and acceptance criteria. Keep product documentation and design decisions under `docs/`, rendered as a VitePress site (`pnpm run docs` builds it; `pnpm run serve` serves it during editing). Link implementation pull requests to the relevant docs and issues.

The repository is in a restart phase: the current implementation is the leaner harness-executor design described in `AGENTS.md`. Improvements continue in sequenced milestones — GitHub comment publication, container sandboxing, managed local model runtimes, and Forgejo/Gitea entry points are planned follow-ups, not present behavior. `src.old/` and `github/action.yaml.old` keep the earlier design as reference material; do not import from them.

The stack is pnpm, TypeScript, Node, vitest, bats, and VitePress. Do not add a second package manager, task runner, formatter, or test framework without an accepted design change. Follow `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `mise.toml`, and the scripts in `package.json`.

## Branches and pull requests

1. Create a focused branch from `main` for each issue.
2. Check it out in a dedicated worktree: `git worktree add ../redline--workspaces/<branch-name> -b <branch> origin/main`. Do not implement changes in the primary checkout.
3. Commit with Conventional Commits.
4. Run `mise run validate` before pushing.
5. Open a pull request linked to the issue and relevant docs pages.

Never merge a pull request without explicit owner approval. Approval, completed tasks, or a green review is not permission to merge.

## Implementation rules

- Keep the review core (`src/review/`) independent of forges, harnesses, and the GitHub Action surface. New harnesses go behind the `HarnessExecutor` interface in `src/harness-executor/`; forge behavior goes behind adapters when forge support lands.
- Pass dependencies into services; do not read `process.env` in domain code — environment parsing lives in `src/review/environment.ts`.
- Treat pull request content as untrusted data: never execute PR code, scripts, builds, or installers; never let PR content alter prompts, permissions, schemas, or output paths.
- Comments explain policy or non-obvious constraints, not the code.
- Prompt modules under `prompts/v4/` are versioned policy. Changing them is a policy change: bump the prompt version and update tests.
- State unsupported behavior directly. Do not present planned behavior as implemented.

## Tests

Each pull request adds or updates tests for changed behavior.

- **Unit tests** (vitest, `test/*.test.ts`) cover parsing, validation, prompt assembly, diff-line mapping, finding validation, and output writing.
- **Integration tests** (vitest) cover the review runner end to end with the echo harness and a scripted executor, plus the CLI entry points.
- **CLI and manifest tests** (bats, `test/*.bats`) cover the built CLI against real bundle fixtures, the GitHub Action manifest contract, and the validation gate itself.
- **Harness matrix** (`test/harness-matrix-run.sh`, used by CI) runs echo, pi, and opencode end to end against the local mock model endpoint; CI uploads each harness's review output as a per-harness artifact, with a scripted finding for pi and opencode so the artifacts demonstrate diff-validated findings.
- **Live-harness tests** are opt-in: `REDLINE_LIVE_HARNESS_TESTS=1` with the harness binaries on PATH.
- **End-to-end tests** against a real repository are manual and opt-in; never target a production repository.

Tests use temporary directories and repositories. They must not modify the contributor's checkout. Network tests beyond loopback must be opt-in and clearly named.

## Before pushing, run the validation gate

```bash
mise run validate
```

The gate runs these tasks in order and stops on the first failure:

1. `mise run typecheck` checks TypeScript without emitting files.
2. `mise run test` compiles sources and tests, then runs the vitest and bats suites. The compilation is the gate's build check.
3. `mise run docs` builds the VitePress site.

Formatting, linting, duplication analysis, dependency vulnerability audits, recorded review-quality evaluation, and Git hooks are not implemented gates. Do not claim they passed or add no-op replacements. Adding them requires a separate reviewed change.

A passing local gate does not prove live model quality, forge comment publication, or production action compatibility.

## Documentation

Product documentation lives under `docs/` as a VitePress site. Register new pages in `docs/.vitepress/config.ts`. Build with `pnpm run docs` before pushing; the gate enforces it. Write documentation plainly and concretely; avoid filler.

## Releasing the action

Published `vMAJOR.MINOR.PATCH` action tags are immutable. Consumers pin the full version; the `vMAJOR` alias moves only through the guarded manual release flow described in the Wiki's Release operations runbook, with repository tag rules requiring the trusted releaser. A release tag must contain the built `dist/` output of the exact reviewed source, because the composite action builds nothing at runtime beyond checking it. Candidate runner images and other container-era machinery from the previous design are not part of the current release; they return with the container-sandbox milestone.

## Pull request checklist

- Branch from `main`, worktree used, Conventional Commits.
- `mise run validate` passes locally.
- Tests added or updated for changed behavior.
- Docs updated when behavior, contracts, or security boundaries change.
- PR linked to its issue; unsupported behavior stated explicitly.
