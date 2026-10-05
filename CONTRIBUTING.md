# Contributing

## Development model

Use GitHub Issues for defects, features, and acceptance criteria. Keep product documentation and design decisions under `docs/`, rendered with VitePress (`pnpm run docs` builds the site; `pnpm run serve` serves it locally during editing). Link implementation pull requests to relevant docs and GitHub Issues.

The repository is in its bootstrap phase. The POC uses pnpm, TypeScript, Node's test runner, Bats, and VitePress. Mise manages tool versions and project tasks. Do not add a second package manager, task runner, formatter, or test framework without an accepted design change. Follow `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `mise.toml`, and the scripts in `package.json`.

The current milestone supports forge-specific GitHub, Forgejo, and Gitea action entry points developed in parallel, OpenCode and Pi, configured existing model endpoints, hosted runners, and forge-appropriate publication credentials. `model-config` selects an explicitly permitted remote/private provider endpoint and model; `model-credentials` supplies separate named bearer or API-key credentials. See the provider-neutral model configuration documentation under `docs/` and its tracking issue. Both backends run in the fixed container sandbox without checkout, host mounts, or GitHub credentials. Generate native harness configuration inside the container and pass only the selected provider credential. Reject arbitrary native config, commands, headers, and ambient environment references. Podman is the default and Docker is the only fallback. Managed local-runtime lifecycle, enforced-egress gateway, and self-hosted runner support remain separate work.

## Set up the repository

Mise installs Node.js 24, Python 3.12, and pnpm 10.33.0. Use pnpm for dependency installation. The pinned pnpm version supports the existing minimum-release-age, overrides, and ignored-esbuild-installer policy in `pnpm-workspace.yaml`. Do not enable esbuild's installer or change that policy to make setup pass.

```bash
mise trust
mise run deps:sync
```

Run `mise tasks` to list the available tasks. Use `mise run <task>` when a task exists. Dependency installation does not configure Git hooks. Run the validation gate yourself before pushing.

## Before starting

1. Read `AGENTS.md` and the linked issue.
2. Read relevant requirements and design pages in the Wiki.
3. Confirm the acceptance criteria and security impact.
4. Check the working tree for existing changes.
5. Create a focused branch from `main`.
6. Check out the branch in a dedicated worktree at `../redline--workspaces/<branch-name>`. Perform all implementation, validation, and commits in that worktree rather than the primary checkout.

Do not start implementation when the requirement changes authentication semantics, comment ownership, trust boundaries, or forge compatibility without a corresponding design update.

## Branches and pull requests

- Every new feature or issue must use its own branch, dedicated worktree, and pull request.
- Do not commit directly to `main`.
- Keep one logical change per branch and pull request.
- Do not mix formatting sweeps or unrelated refactors with product changes.
- After implementation and validation, commit the change, push the branch, and open a pull request.
- Describe the user-visible behavior, security impact, tests, and documentation changes in the pull request.
- Link the issue that defines the acceptance criteria.
- Never merge a pull request unless the owner explicitly instructs you to merge it. Approval or successful review alone is not permission to merge.

## Implementation rules

- Use Bash for shell-based collection and workflow tasks. Use TypeScript only when the feature needs application code that Bash cannot handle clearly.
- Provide forge-specific action entry points (including `github/action.yaml` and a Gitea-compatible manifest under `gitea/`) and develop them in parallel. Their engines and manifest formats differ; keep review flow in shared core code and forge integration in adapters.
- Keep the review domain independent from forge SDKs, action runtimes, Pi, and OpenCode.
- Add forge-specific behavior through adapters.
- Add authentication methods through credential providers. Never branch on authentication mode throughout the domain layer.
- Put Pi and OpenCode behind one review-backend interface.
- Put Ollama, LM Studio, llama.cpp, OpenRouter, and later model tools behind model-runtime adapters.
- Keep runtime lifecycle separate from review-backend configuration.
- Track ownership for every server process and loaded model. Cleanup must not affect resources that existed before the action.
- Validate all model output before using it.
- Keep backend tools and permissions read-only during reviews.
- Keep review instructions fixed and versioned. Do not add free-form trusted guidance; repository content and action context must remain explicitly delimited untrusted data.
- Do not execute code from the pull request under review.
- Keep forge credentials in the publication and API-client layers. Give a review backend only the model-provider credential it needs. Do not write credentials into the checkout or prompt.
- Use least-privilege tokens and short-lived GitHub App installation tokens.

## Tests

Each pull request must add or update tests for changed behavior.

Use these test levels:

- Unit tests cover pure review policy, parsing, validation, filtering, and mapping.
- Contract tests cover forge event payloads and API request or response translation.
- Integration tests cover Pi and OpenCode setup, action input parsing, authentication providers, model-runtime lifecycle, and multi-component flows with controlled dependencies.
- End-to-end tests may write to a dedicated test repository only. They must never target a production repository.

Tests must use temporary directories and repositories. They must not modify the contributor's checkout. Network tests must be opt-in and clearly named.

Before pushing, run the implemented validation gate:

```bash
mise run validate
```

The gate runs these tasks in order and stops on the first failure:

1. `mise run typecheck` checks TypeScript without emitting files.
2. `mise run test` compiles the sources and tests, then runs the Node and Bats suites. The compilation is the gate's build check.
3. `mise run docs` builds the VitePress site.

Formatting, linting, duplication analysis, dependency vulnerability audits, recorded review-quality evaluation, and Git hooks are not implemented in this POC. The former Mise task references and contribution-guide claims did not provide those checks. Issue #79 aligns the gate with the checks that exist; it does not certify the missing checks. Adding them requires a separate reviewed change, not passing no-op scripts. Future review-quality corpora and thresholds require explicit owner review. Live model evaluation must remain opt-in and must not receive a GitHub publication token.

The Bats validation-gate tests check task/script references, gate order, build coverage, and the pnpm tool pin. A passing local gate does not prove native backend compatibility, live model quality, image publication, or forge comment publication.

## Security review

Treat every pull request diff, file, filename, comment, and configuration value as untrusted input.

A change requires explicit security review when it:

- Adds a tool or permission available to Pi or OpenCode.
- Adds or changes a model-runtime command, executable path, endpoint, health check, model download, or cleanup rule.
- Executes a repository command.
- Changes token permissions or secret storage.
- Changes prompt construction, specialist/arbiter orchestration, or model-visible context.
- Changes repository review-memory parsing, matching, expiry, suppression, preference, or audit semantics.
- Changes managed-comment ownership checks.
- Adds support for public fork pull requests.
- Sends source code to a new model provider.

Never include real tokens, GitHub App private keys, webhook secrets, or model credentials in fixtures, logs, snapshots, prompts, or issue comments.

## Candidate runner images

Candidate publication is owner-approved maintenance, not an automated PR review. The infrastructure change must pass independent security review and receive separate merge approval before it can run from `main`. Dispatch and later production pin changes each require explicit owner approval. Never merge an incompatible host contract merely to trigger the existing main image publisher.

Before dispatch, review the exact open same-repository PR head and configure the protected `candidate-images` environment. Require only the personal repository owner as reviewer, allow that single owner to approve their own dispatch, restrict deployments to the exact `main` branch, and disable administrative bypass. The workflow checks exposed reviewer and branch-policy fields. Administrative bypass and source review remain manual attestations, not API-verified facts.

Approval authorizes the exact source SHA. The workflow rejects stale heads before building. If the PR moves during an approved build, publication remains bound to the original SHA. Cancel the run to revoke in-flight approval. A candidate tag can move on rerun; use captured immutable digests and provenance instead of tag names. Verify both architectures, bootstrap hashes, and native versions, then independently review pin changes against the approved source-file hashes. Changed runner files require a new approved build.

The publisher may execute reviewed Dockerfile build steps only after the maintenance approval. Preflight must not import or execute selected-source scripts, install its dependencies, check out that head, or forward host configuration or credentials into the exact allowlisted context. This exception does not relax the ban on executing PR code in review workflows. Report partial publication explicitly. Do not prune packages, move `latest` or stable tags, update pins automatically, or merge automatically.

See [Candidate runner images](docs/candidate-runner-images.md) for setup, unsupported cases, digest verification, and recovery. Local checks do not prove registry authorization, published-image compatibility, or live GLM review success. Report the exact validation gate and results; do not treat its implemented scope as the missing quality checks.

## Releasing the action

The supported consumer references are immutable `vMAJOR.MINOR.PATCH` tags and the moving compatibility tag for that major, such as `v1.0.0` and `v1`. Branch names, pull request refs, and arbitrary commit references are not supported release channels. Never create, move, or delete release tags by hand.

### One-time repository setup

Before the first dispatch:

1. Create a protected GitHub environment named `release`. Configure required reviewers and restrict deployments to `main`. Create it explicitly—otherwise GitHub can auto-create an unprotected environment when the workflow first references it.
2. Configure repository tag rules for the `v*` namespace. Immutable full-version tags must not be updated or deleted. The trusted release workflow must be allowed to create full-version tags and atomically advance the matching `vMAJOR` alias; ordinary users and workflows must not.
3. Keep the workflow's top-level permissions empty. Preflight receives only `contents: read`; only the environment-gated publisher receives `contents: write`.
4. Confirm required branch checks and the release/tag rules with a repository administrator before dispatching.

Tag rules must distinguish the intentionally moving major alias from immutable full-version tags, or grant the trusted publisher an appropriately narrow bypass. Do not weaken immutable-tag protection merely to let `vMAJOR` move.

### Version selection

The operator does not choose a version or bump. Preflight inspects validated published releases and non-merge Conventional Commits from the highest published stable release to the exact current `main` revision:

- `type!:` or `type(scope)!:`, or a trailing `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer, selects a major release;
- any `feat` commit selects a minor release when no breaking change exists;
- every other valid Conventional Commit history selects a patch release;
- the first stable release is always `v1.0.0`.

Malformed, empty, excessive, oversized, non-ancestor, orphaned, or ambiguous history fails closed. Merge commits are excluded, while their conventional branch commits remain in the range.

### Dispatch and approval

Use **Actions → Release versioned action → Run workflow**, select `main`, and run it without inputs. The equivalent CLI command is:

```bash
gh workflow run release.yml --repo dragoscirjan/redline --ref main
```

Preflight validates and rebuilds the repository, proves the committed bundles are clean, derives the exact version, and performs no writes. After the `release` environment is approved, the privileged job checks out and executes only the reviewed `dist/action-release.js` bundle. Immediately before its first mutation, the publisher revalidates that the captured target is still current `main`. Once mutation starts, that invocation remains bound to the captured version and target and may finish if `main` advances concurrently. A later dispatch or failed-job rerun cannot publish that older target.

### Verification

After a successful run, verify the immutable tag and stable GitHub Release target the dispatched `main` commit, and inspect the moving major alias:

```bash
git ls-remote https://github.com/dragoscirjan/redline.git \
  refs/tags/v1 refs/tags/v1.0.0
gh release view v1.0.0 --repo dragoscirjan/redline \
  --json tagName,isDraft,isPrerelease,targetCommitish,url
```

Substitute the version selected in the preflight log. The immutable full-version tag must always resolve directly to the dispatched commit, and the release must be published, stable, and attached to that tag. Immediately after publication, `vMAJOR` must resolve to the same commit; if a later same-major release has since shipped, it must instead resolve to that latest validated stable release.

### Retry and recovery

A dispatch against an already released current `main` is a no-op. If a run fails after a write, inspect tags and the GitHub Release before doing anything manually. GitHub API visibility can lag behind a successful tag or Release write; rerunning the failed jobs against the same unchanged `main` safely revalidates the uniquely expected state:

```bash
gh run rerun RUN_ID --repo dragoscirjan/redline --failed
```

Do not retry an old release after `main` advances. The publisher intentionally rejects stale ancestor publication, conflicting tags, unexpected orphan tags, and ambiguous remote state. Never force-push a release tag or create the GitHub Release manually to bypass a failed check.

### Rollback limitations

Published `vMAJOR.MINOR.PATCH` tags are immutable and releases are not rolled back by moving or deleting them. Correct a bad release with a reviewed fix-forward commit and a new release. The guarded workflow is the only supported mechanism for advancing `vMAJOR`; consumers requiring a permanently fixed revision should pin the immutable full-version tag.

The detailed trust boundaries and operator checklist are in the Wiki's [Release operations](https://github.com/dragoscirjan/redline/wiki/Release-operations) runbook.

## Documentation

Update documentation in the same pull request when behavior or configuration changes. Before writing or editing documentation under `docs/`, read and follow `.agents/skills/unslop/SKILL.md`. Keep `AGENTS.md` and this file current when the development approach changes. Before changing either file, inform the owner what needs to change and ask for permission; do not edit them until permission is granted.

- Keep `README.md` focused on installation, configuration, and basic use.
- Keep contribution workflow in this file.
- Keep instructions for coding agents in `AGENTS.md`.
- Keep product documentation, requirements, and low-level design under `docs/`; render documentation with VitePress. Register new pages in `docs/.vitepress/config.ts`; `pnpm run docs` runs in CI, and the site publishes under `projects/redline/` on dragoscirjan.github.io after pushes to `main`.
- Use `.agents/skills/unslop/SKILL.md` whenever writing or editing documentation.
- Record unsupported behavior and limitations.
- Use concrete names, defaults, examples, and failure behavior. Avoid claims that are not backed by code or tests.

## Commits

Use Conventional Commits with the linked GitHub issue number as the scope. No installed hook enforces this format; check it before committing:

```text
feat(#21): add GitHub App credential provider
fix(#22): reject comments outside changed lines
docs(#23): document PAT review identity
test(#24): cover renamed files in diff mapping
```

Keep commits reviewable. A commit should build and pass the relevant tests unless the pull request documents why an intermediate commit cannot do so.

## Pull request checklist

- [ ] The change has a linked issue and clear acceptance criteria.
- [ ] The implementation follows the current requirements and design.
- [ ] Tests cover normal, failure, and security-sensitive paths.
- [ ] Model output remains schema-validated.
- [ ] No caller-supplied trusted review guidance is accepted; model instructions remain fixed and versioned.
- [ ] Runtime cleanup stops or unloads only resources owned by the action.
- [ ] Runtime processes use trusted executables, fixed argument construction, readiness timeouts, and loopback binding by default.
- [ ] No credential can enter model context or logs.
- [ ] No pull request code executes during review.
- [ ] Documentation reflects the changed behavior.
- [ ] Required local validation passes.
- [ ] The working tree contains no generated or unrelated files.
