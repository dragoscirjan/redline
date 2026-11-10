# AGENTS.md

## Project and current phase

- The project is named `redline`.
- Initiative 4.0 replaces Pi/OpenCode execution with a Redline-owned bounded model/tool runtime. The planned integrations are the official OpenAI-compatible TypeScript SDK and official MCP client. They are not implemented in the scaffold.
- The active project is a scaffold. Its local command and Docker skeleton expose help/status and explicitly reject review execution. RPC execution is not implemented. Do not present planned reviews, MCP execution, publication, or standalone-binary packaging as working features.
- Redline has three required, first-class usage modes:
  1. An npm-installed local executable (`npm install --global @dragoscirjan/redline`, then `redline`), usable without Docker.
  2. A Docker image (`docker run ...`).
  3. An editor-neutral JSON-RPC server over standard input/output, used by VS Code and other IDEs.
  All three must use one shared review engine. CLI, Docker and RPC entrypoints must not duplicate review policy, validation or publication logic. These are product requirements, not claims that every mode works in the scaffold. An npm-installed executable does not imply a runtime-free standalone binary.
- `src.pre-v4/` preserves the preceding source. `archive/pre-v4/` preserves its tests, assets, delivery configuration, documentation, and baseline references. These are historical reuse references, not a second active runtime. Active code must not import them or ship them accidentally.

## Instruction routing

Load only the instructions required for the current phase.

| Trigger | Required instructions |
|---|---|
| Before planning or performing a repository architecture, design, code, documentation, configuration, policy, or publication change | Read and follow `CONTRIBUTING.md`. |
| Before any repository mutation | Follow `.agents/skills/isolated-workspace/SKILL.md` and the workspace configuration below. |
| Before delegating to child agents | Follow `.agents/skills/subagent-orchestration/SKILL.md`. This route does not authorize delegation; an operator request or applicable workflow must authorize it. |
| Before validating, committing, pushing, or publishing | Read and follow `VALIDATION.md`. |
| Before auditing or removing workspaces | Follow `.agents/skills/cleanup-workspaces/SKILL.md`. |
| When instructions or skill routes are missing, stale, conflicting, duplicated, or unsuitable | Follow `.agents/skills/instruction-maintenance/SKILL.md` for a read-only audit and exact proposal. |

Stop before a gated phase if its required instructions are unavailable. Use
skill frontmatter to select task-specific skills; do not preload every skill.
Read-only inspection does not require deferred contribution instructions unless
the task needs them.

Every workspace cleanup, including removal of a current-task temporary lane,
requires explicit owner approval of the exact cleanup plan. Permission to create
or use a lane is not permission to remove it. This target rule overrides the
imported lane-cleanup exception.

## Development workflow

- For any architecture, design, implementation, or coding request that does not already have a GitHub issue, invoke `grill-me` before planning or changing files. Continue until the owner explicitly confirms shared understanding. Then create a GitHub issue with the agreed requirements and acceptance criteria. Begin work only after the issue exists.
- Apply `unslop` to every user-facing response, including questions, progress updates, review replies, and final answers.
- Read `CONTRIBUTING.md` before changing the repository.
- Before planning or implementing replacement behavior, inspect the corresponding code in `src.pre-v4/` and follow CONTRIBUTING.md's "Initiative 4.0 source reuse" rules. Reuse or adapt compatible code before writing a replacement.
- For every new feature or issue, create a focused branch from `main` and work in its dedicated sibling worktree. Use the full issue-focused branch name selected for the task; the final branch component names the worktree.
- Commit with Conventional Commits. Run `mise run validate` before pushing.
- Open a pull request linked to the issue. Never merge without explicit owner instruction; approval or a green review is not permission to merge.
- Present the exact proposal and get owner approval before changing `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, or `VALIDATION.md`.

### Workspace configuration

- VCS: Git. Pass `--vcs git` explicitly.
- Base revision: `origin/main`.
- Pass the full branch name explicitly. Do not import an upstream branch prefix.
- Detect the primary repository and derive its sibling `<repository>--workspaces/<final-branch-component>` path through the workspace skill.
- Review the helper's exact plan and obtain owner approval before applying it.
- State the active branch and absolute worktree path in every final repository-work report.

## Active and planned boundaries

- `src/cli/` owns command parsing and process exit behavior.
- `src/application/` owns the current scaffold status and future shared application orchestration. CLI, RPC and Docker must not grow separate review engines.
- `src/model-runtime/` is reserved for the future direct model adapter and bounded conversation loop. Provider wire details belong here, not in review policy.
- `src/mcp/` is reserved for future tool discovery, dispatch, permissions and MCP connection lifecycle.
- `src/review/` is reserved for reused review policy, authoritative validation and artifact orchestration.
- `src/publish/` is reserved for reused forge adapters and managed publication policy.
- `bin/` and `scripts/build.js` retain the reusable Node/Bun launcher and compiled distribution pattern.
- `containers/` contains the scaffold image definition. Do not claim that it bundles the old review tools.
- `docs/` describes the active scaffold and Initiative 4.0. Historical product documentation lives under `archive/pre-v4/docs/`.

A reserved boundary is not an implemented service. Do not add placeholder
successes, speculative frameworks, or unused SDK dependencies to make it appear
complete.

## Security and correctness requirements

These requirements govern restored behavior even while review execution is unavailable:

- Preserve model/provider reasoning. Never disable reasoning to reduce cost, latency, or output budgets.
- Treat pull request source, diffs, model responses, and tool results as untrusted. Never execute untrusted pull request code, scripts, builds, or installers during isolated reviews. They must not change system policy, credentials, permissions, schemas, or output destinations.
- Docker is an execution isolation boundary, not protection from a hostile host or kernel. Bare local execution is unsandboxed and must warn prominently when command-capable functionality is restored.
- MCP clients are not sandboxes. Configuration trust and tool permissions must be explicit. Preserve the ability to configure additional tools; do not silently replace the prior local/Docker behavior with a fixed MCP allowlist.
- Preserve the existing isolated GitHub Actions restrictions until a separately approved migration replaces them. Archived workflow assumptions are not automatically valid for the new runtime.
- Send only the selected model credential to the model adapter and explicitly configured credentials to MCP servers. Publication tokens remain confined to publication, never model/tool execution.
- Redact credentials before writing diagnostics, raw model output, reports, suggestions, or fix prompts. Do not enable SDK tracing or payload logging by default.
- Restore authoritative finding checks rather than trusting structured generation: both finding span endpoints must map to changed lines of the authoritative diff, with byte-identical evidence at the start line. Verify indexed context repository/head identity. Indexed relationships only select candidates; resolve paths/spans from bounded captured source. Invalid optional indexed context degrades to explicit file-only coverage.
- Restore managed-publication ownership checks and stale-head rejection. Managed objects require the marker and expected author. If an App actor is initially unresolved, require the marker plus managed heading, learn the actor from the first created object, and fail closed on ambiguity. Preserve the caps of 25 file reviews and 100 inline comments, bounded partial failures, and the managed summary. Auto-review targets only Redline's own pull requests; other repositories must opt in with their own token or App. Do not publish arbitrary unmarked objects.
- Distinguish requested controls, advertised capabilities, observed calls, successful tool results, model assertions, and validated findings. Missing optional integrations warn without blocking configured tools; unmet required capabilities fail explicitly. Unsupported controls never silently downgrade.
- Bound process/model/tool execution, retained output, conversation growth, retries, and deadlines. Launch executables with argument arrays only. Endpoints, executable paths, and model identifiers must come from trusted configuration.

## Validation and delivery status

- Keep the required `mise run validate` sequence: typecheck, Vitest/Bats tests, and VitePress build.
- During the scaffold, active tests validate its honest command behavior, Node/Bun launchers, build/package boundaries, archive exclusion, and Docker definition. Parked legacy suites are not active coverage and must not be reported as passing.
- Tests use temporary directories and never mutate the contributor's checkout. Beyond-loopback network and live-model checks remain opt-in.
- Automatic publication and production review workflows are parked during the scaffold. Re-enabling them requires an explicit delivery/security proposal and real installed-artifact checks.
- No package-version decision, release, standalone-binary claim, live-provider compatibility claim, or new forge support is implied by Initiative 4.0.
