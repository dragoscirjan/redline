# Contributing to Redline

## Set up the repository

Mise installs Node.js 24, Bun 1.4.4, Python 3.12, and pnpm 10.33.0. Use pnpm for dependency installation. Preserve the minimum-release-age, overrides, and ignored-esbuild-installer policy in `pnpm-workspace.yaml`. Do not enable esbuild's installer or change that policy to make setup pass.

```bash
mise trust
mise run deps:sync
```

Use `mise run <task>` when a task exists. Dependency installation does not configure Git hooks. Run the validation gate yourself before pushing. Do not install missing tools or dependencies without the required approval.

## Development model and current phase

Use GitHub Issues for defects, features, and acceptance criteria. Initiative 4.0 is tracked in #234. Keep current product documentation and design decisions under `docs/`, rendered with VitePress, and register new pages in `docs/.vitepress/config.ts`.

The active implementation is a scaffold for replacing Pi/OpenCode with a Redline-owned bounded runtime using an OpenAI-compatible SDK and the official MCP client. The SDK integrations, review execution, MCP tools and publication are not implemented yet. Help/status and build/package checks must report this honestly; review commands fail explicitly rather than invoking the archived runtime or reporting a clean review.

A local executable that does not require Docker and a Docker image are both required deliverables. They share one engine. The current Node/Bun launcher is not a self-contained binary promise. Resolve executable packaging and supported platforms explicitly before claiming delivery.

Automatic package/image/docs publication and production review workflows are parked during the scaffold. Their presence in the archive does not authorize running them or publishing the scaffold as a finished review tool. Keep the package version unchanged unless the owner approves a version decision.

The stack remains pnpm, TypeScript, Node, Bun, Vitest, Bats, and VitePress. Do not introduce a second package manager, task runner, formatter, or test framework without an accepted design change. Follow `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `mise.toml`, and `package.json`.

## Branches and pull requests

1. Create a focused branch from `main` for each issue.
2. Follow `.agents/skills/isolated-workspace/SKILL.md` to plan and create its dedicated sibling worktree. Pass `--vcs git`, the full branch name, and `--base origin/main`. Obtain approval of the exact plan before applying it. Do not implement changes in the primary checkout.
3. Commit with Conventional Commits.
4. Run `mise run validate` before pushing.
5. Open a pull request linked to the issue and relevant docs pages.

Never merge without explicit owner approval. Approval, completed tasks, and a green review are not permission to merge. Workspace creation/use is not permission to remove it; cleanup requires approval of its exact plan.

## Initiative 4.0 source reuse

The implementation parked in `src.pre-v4/` is the reference baseline for Initiative 4.0. Its related tests, assets, docs, and delivery configuration are parked in `archive/pre-v4/`. The archive manifest records the baseline commit and original paths.

Before planning or implementing a replacement behavior, inspect its archived implementation and relevant tests. Reuse the implementation when it meets the new runtime design. Adapt it when compatible behavior can be separated from harness-specific code. Do not reimplement existing behavior without recording why reuse or adaptation would be unsuitable.

Record the archived paths considered and the reuse, adaptation, or replacement decision in the implementation issue or pull request. Copy or move reusable code into active `src/` with its applicable tests and contracts. Preserve authoritative validation, evidence checks, redaction, and publication boundaries. Fix or reject unsafe or incompatible code; reuse does not justify retaining defects or obsolete dependencies.

Keep the archive historical. Apply production fixes to the active implementation, not the archived copy. Active code must not import archived modules, and builds, npm packages, Docker contexts/images, TypeScript discovery, tests, and current documentation must not discover or ship archived files accidentally. A temporary comparison mechanism needs an explicit plan and must not become a second maintained runtime.

Approve any further archive/bootstrap plan and exact protected instruction changes before moving more material or changing policy. Do not delete or overwrite preserved work as cleanup.

## Implementation rules

- Never disable model reasoning. Preserve owner-selected model/provider behavior; do not force reasoning off to reduce cost, latency or output budgets.
- Keep review policy, finding validation and artifact contracts independent of model providers, MCP transports, forges, and entrypoints. Put provider request fields and conversation control behind the model-runtime boundary; put MCP connections and dispatch behind the MCP boundary.
- Pass dependencies into application/domain services. Parse environment, configuration and CLI input at entrypoint boundaries rather than reading `process.env` in domain code.
- Treat pull request content as untrusted. Never execute its code, scripts, builds or installers during isolated reviews, and never let it change prompts, permissions, schemas, credentials or output paths.
- When restoring local command-capable tools, prominently state that bare local execution is unsandboxed. Docker provides a container boundary, not protection from a hostile host/kernel. SDKs and MCP connections do not provide isolation themselves.
- Preserve selected-credential-only handling, redaction before persistence, and publication-token separation. Do not enable request/response tracing by default.
- Restore authoritative source/diff validation and managed-publication protections from the archived implementation; structured generation is not proof of correctness. Keep existing isolated Actions restrictions until an explicitly reviewed migration replaces them.
- Preserve configurable additional MCP tools in local/Docker profiles. Define trust and permissions explicitly; do not silently impose a fixed allowlist or inherit executable configuration from untrusted reviews.
- Start binaries with argument arrays. Bound tools, requests, output, retries, and elapsed time. Declare unsupported capabilities and fallback policy; never silently downgrade.
- Review prompts are versioned policy. Reusing an unchanged prompt preserves its identity; changing policy requires a version bump and corresponding contract tests. Archived prompt versions are not the active scaffold's policy.
- Comments explain policy or non-obvious constraints, not the code. State unsupported and unimplemented behavior directly.

## Tests and validation

Each pull request adds or updates tests for changed behavior. Keep `mise run validate` as the required typecheck, Vitest/Bats, and VitePress gate. Read `VALIDATION.md` before validating, committing, pushing or publishing.

During the owner-approved scaffold phase, active tests cover honest help/status and unsupported-review behavior, source/build/package execution under Node/Bun, archive exclusion, and the Docker definition. The parked legacy suites are preserved references, not active coverage or passing results. Restore the relevant behavior/security regression tests as functionality returns.

Tests use temporary directories and repositories and never modify the contributor's checkout. Beyond-loopback network, Docker builds that need remote images, live-provider calls, and paid checks must be explicit and reported separately. Do not weaken tests or introduce no-op gates to make validation pass.

## Agent instruction maintenance

`AGENTS.md` routes shared instructions; `CLAUDE.md` imports it. Keep detailed procedures in skills or deferred documents. Imported assets do not override Redline's security rules, workflow gates, toolchain policy, or owner authority.

Use `instruction-maintenance` for a read-only drift audit and exact proposal. Obtain explicit approval of the stated files and changes before editing protected instructions. Changed scope, evidence, dependencies or protected rules requires a revised proposal. Audit/validation is not permission to mutate, publish, merge or release.

## Documentation and future release work

Document the active scaffold honestly. Historical product and release documentation lives under `archive/pre-v4/`; it is a reuse reference, not a claim of current support.

Before restoring release automation, approve the local executable/container support matrix, runtime prerequisites, artifact contents, dependency licenses/notices, security profiles and version/compatibility policy. Run real installed-artifact checks, retain immutable release identities/provenance, and verify that no archive enters production artifacts. Preserve immutable existing action/package releases; do not overwrite or invent historical artifacts.

## Pull request checklist

- Focused issue and isolated worktree; Conventional Commits.
- Reuse/adaptation/replacement decisions identify archived source and tests.
- `mise run validate` passes; additional checks and limits are reported truthfully.
- Tests and current docs describe implemented behavior without claiming archived functionality.
- Protected instruction/security/validation changes have exact owner approval.
- No automatic publication, merge, release, or workspace removal without its required approval.
