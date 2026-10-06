# AGENTS.md

## Project

- The project is named `redline`.
- Redline reviews pull requests: it builds a review context bundle from the
  base-to-head change, runs one fixed review prompt per file through a
  harness executor, validates every finding, and writes per-file review
  output plus a run summary as JSON and Markdown files. When a publication
  token is supplied, the same output is published to GitHub: one review per
  file with findings (one inline comment per finding) plus a managed
  summary comment.
- The current milestone runs on GitHub Actions through
  `github/action.yaml`. Forgejo and Gitea entry points are planned; the
  review core must stay forge-independent so they can reuse it.
- The review harnesses are Pi and OpenCode today, plus a deterministic
  `echo` harness used by tests and CI. The executor interface is the
  extension point for more harnesses.
- `src.old/` and `github/action.yaml.old` hold the previous design and
  remain as references only. Nothing imports from them.

## Development workflow

- Read `CONTRIBUTING.md` before changing the repository.
- For every new feature or issue, create a focused branch from `main`, check
  it out in a dedicated worktree at
  `../redline--workspaces/<branch-name>`, and work there.
- Commit with Conventional Commits. Run `mise run validate` before pushing.
- Open a pull request linked to the issue. Never merge without explicit
  owner instruction; approval or a green review is not permission to merge.
- Inform the owner and get permission before changing `AGENTS.md` or
  `CONTRIBUTING.md`.

## Architecture

- `src/harness-executor/` — the abstract executor layer. One interface
  (`HarnessExecutor`), one implementation per harness (`pi`, `opencode`,
  `echo`), a factory/registry, and a bounded process runner. Executors own
  all harness concerns: generated configuration, credentials, model
  selection, non-interactive invocation with tools disabled, bounded
  output, and timeouts.
- `src/review/` — the review tool. Parses the `REDLINE_*` environment
  contract, loads the context bundle, builds fixed versioned prompts from
  `prompts/v3/`, runs one prompt per reviewed file, validates each review
  document against the authoritative diff, and writes per-file records and
  the run summary. Runs as a CLI (`redline-review`) and as the GitHub
  Action component.
- `src/context-bundle.sh` — builds the review context bundle (manifest,
  diffs, base files, source-at-head). The `reviewed` flag is computed here
  deterministically: lock files, vendored dependencies, build output, and
  binary files are excluded from review.
- `src/review/remediation.ts` — derives the change suggestion and the fix
  prompt from validated findings. Suggestions render only from authoritative
  span content (diff coverage, then head/base file); fix prompts are
  deterministic and always present.
- `src/publish/` — the publication layer, currently behind a
  `ReviewPublisher` interface with the GitHub adapter. It publishes one
  review per file with validated findings and upserts one managed summary.
  Every managed object carries a machine-readable marker; updating or
  creating one requires both the marker and the expected author. A
  stale-head check aborts publication when the pull request moved past the
  reviewed commit. Caps bound the run (25 file reviews, 100 inline
  comments); per-file failures are reported and never abort the run. A
  Forgejo/Gitea publisher would implement the same interface.
- `prompts/v4/` — the fixed, versioned review policy. Prompt changes are
  policy changes: bump the prompt version and update the contract tests.

## Environment contract

The GitHub Action passes all values to the review tool through environment
variables (interim design; see `src/review/environment.ts`):

- `REDLINE_HARNESS` — echo, pi, or opencode.
- `REDLINE_REVIEW_DIR`, `REDLINE_SOURCE_DIR`, `REDLINE_OUTPUT_DIR` — bundle,
  source-at-head, and output directories.
- `REDLINE_MODEL_CONFIG` — JSON: provider, endpoint, model.
- `REDLINE_MODEL_AUTH` — provider-keyed credential map; only the selected
  credential reaches the harness.
- `REDLINE_FINDING_SCOPE`, `REDLINE_TIMEOUT` — optional policy values.
- `REDLINE_PUBLISH_TOKEN`, `REDLINE_REPOSITORY`, `REDLINE_PULL_REQUEST`,
  `REDLINE_HEAD` — the publication context; all four must arrive together
  and only with review execution. The token is the Redline GitHub App
  installation token generated in the action, or an outside-provided PAT
  as fallback — never the Actions `GITHUB_TOKEN`. The action mints two
  tokens: one for the start/failure notifications, one fresh for the
  publication after the review completes; the review step itself runs
  token-free.

Review inputs must arrive together; partial selections fail. Unknown
`REDLINE_*` variables are rejected.

## Security boundaries

- Pull request content is untrusted data. Never execute pull request code,
  scripts, builds, tests, or package installers during a review.
- Harnesses run with every tool disabled, isolated generated configuration,
  and a constructed environment. No ambient credentials or GitHub tokens
  reach a harness. The publication token lives only in the publication
  layer, after review artifacts are written.
- Publication writes only managed objects: identified by marker plus the
  expected author when the token's actor is known, or by marker plus the
  managed heading when an App installation token has no resolvable
  identity (the actor is then learned from the first created object;
  ambiguity fails closed). Redline's own pull requests are the only
  auto-review target: the dogfood workflow publishes on this repository;
  other repositories opt in through the reusable workflow with their own
  token or App.
- Repository content, PR metadata, paths, and diff text never alter the
  system prompt, tool permissions, result schema, or publication policy.
- Model output is rejected rather than guessed: findings must map both span
  endpoints to changed lines of the authoritative diff with byte-identical
  evidence at the start line.
- Persisted diagnostics, reasons, raw model output, suggestions, and fix
  prompts are redacted against the selected credential before any artifact is
  written.
- Start harness binaries with argument arrays only. Accept executable paths,
  endpoints, and model identifiers from trusted workflow configuration only.

## Testing

- Unit and integration tests run with vitest (`test/*.test.ts`); CLI,
  action-manifest, bundle, and gate tests run with bats (`test/*.bats`).
- The CI harness matrix (`test/harness-matrix-run.sh`) runs every harness
  end to end against the local mock model endpoint
  (`test/fixtures/mock-model-server.mjs`) and uploads each harness's review
  output as a `harness-<harness>-reviews-…` artifact — pi and opencode are
  served a scripted finding so the artifact carries diff-validated findings,
  not only clean runs. No secrets or live models.
- Live-harness integration tests are opt-in via
  `REDLINE_LIVE_HARNESS_TESTS=1` and need the harness binaries on PATH.
- Tests use temporary directories only and never mutate the source checkout.

## Future milestones

The original design is not abandoned; it is sequenced. Planned next steps
include a container sandbox and credential gateway for untrusted runner
environments, managed local model runtimes, and Forgejo/Gitea entry points.
Do not present these as implemented behavior.
