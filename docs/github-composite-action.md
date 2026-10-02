# GitHub composite action contract

`github/action.yaml` builds a review context bundle for a pull request's exact base and head commits. When the caller also supplies the review inputs, it runs the full review in a digest-pinned container and publishes findings on the pull request. The action orchestrates composite steps; the review core lives in TypeScript under `src/`.

## Modes

The action runs in one of two modes:

- **Context bundle only.** The caller supplies no review inputs. The action validates the pull request event, builds the trusted checkout, builds the bundle, and uploads it. Existing callers such as `.github/workflows/code-review.yml` use this mode.
- **Full review.** The caller supplies `backend`, `model-config`, `model-auth`, and `runner-image` together, plus an explicit `credential-isolation: direct` and a `github-token` for publication. The action then also stages the runner container, runs the review backend, publishes findings, and uploads the review journal. Supplying only part of the review selection fails validation with exit code 2.

Context-only mode never requires `github-token`; the token is needed only when findings are published.

## Inputs

Every input is fixed data. No input accepts free-form review instructions. TypeScript validation in `src/action-inputs.ts` is authoritative; the shell step only checks event context.

| Input | Values | Default |
| --- | --- | --- |
| `backend` | `pi` or `opencode` | none |
| `model-config` | JSON object with `provider`, `endpoint`, `model` | none |
| `model-auth` | JSON object mapping provider names to credential strings | none |
| `github-token` | GitHub publication token | none |
| `finding-scope` | `defects` or `defects-and-risks` | `defects` |
| `report-style` | `single-block` or `inline` | `single-block` |
| `timeout` | duration string, for example `10m`, `2h`, or `1h30m` | `30m` |
| `credential-isolation` | `direct`, required explicitly in review mode | none |
| `runner-image` | image reference ending in `@sha256:` followed by 64 hex characters | none |
| `container-engine` | `podman` or `docker` | `podman` |
| `artifact-name` | bounded artifact name | `redline-review-<run id>` |
| `artifact-retention-days` | integer from 1 to 90 | `45` |

Validation rules:

- The `timeout` parser accepts `h` and `m` components in that order, for example `2h`, `10m`, or compound `1h30m`. The parser rejects values above the 360-minute GitHub Actions job cap with a validation error. Any value with a `d` component exceeds the cap, so `1d` is rejected instead of clamped. A caller who sets a job-level timeout must leave margin above the review deadline so container cleanup and artifact upload can still run.
- `credential-isolation` requires an explicit `direct` value when review execution is enabled. There is no default, so a caller cannot enable full review without choosing the credential path deliberately.
- Unknown inputs and unknown `REDLINE_*` environment variables are rejected. Optional inputs are validated even in context-only mode, so a typo in `finding-scope` or `timeout` fails the workflow instead of passing silently.
- `runner-image` must be pinned by an immutable digest. Tags fail validation. Issue #23 will replace this input with a fixed backend-to-digest table.
- `artifact-retention-days` accepts 1 through 90. The default of 45 is half of GitHub's maximum.
- `model-config` follows the [runnable review configuration](runnable-review-configuration.md): exact JSON shape, 16 KB byte limit, absolute HTTP or HTTPS endpoint, no URL credentials or fragments.

## Secrets

The caller binds secrets to inputs because composite actions cannot read the `secrets` context:

```yaml
uses: dragoscirjan/redline/github@<immutable-ref>
with:
  github-token: ${{ secrets.GH_TOKEN }}
  model-auth: ${{ secrets.MODEL_CREDENTIALS }}
  # remaining review inputs
```

Boundaries:

- `github-token` stays in host publication code. It never enters the model container, the context bundle, or the prompt.
- The full `model-auth` map stays host-side. The container staging layer sends only the selected provider credential through the stdin bootstrap channel. Unused map entries never leave the host.

## Pipeline

1. **Validate inputs.** A shell step checks that the event is a `pull_request` event and that the base and head are full object ids. After the trusted build, a TypeScript validation step (`redline-github-action --validate-only`) validates every input, including optional inputs in context-only mode.
2. **Build trusted TypeScript.** The step installs dependencies with `pnpm install --frozen-lockfile --ignore-scripts` and builds the action checkout. The checkout is the trusted base revision for `pull_request` events. Pull request code is never installed, built, or executed.
3. **Fetch pull request commits as data.** `git fetch` retrieves the exact base and head revisions. Nothing checks out pull request content as the working tree.
4. **Build the review context bundle.** `src/context-bundle.sh` writes the bounded bundle under the workspace.
5. **Upload the context bundle.** The bundle uploads before the review starts, so a failing review cannot erase it.
6. **Run the review.** When review inputs are present, the step calls `redline-github-action` (built at `dist/src/github-action-run-cli.js`). That CLI parses and validates the environment, builds the frozen configuration, selects the single provider credential, stages the container through `createContainerStagingLauncher`, and runs `runReview` with the fixed versioned prompt, journal, and publication service.
7. **Upload the review journal.** The journal uploads with `if: always()`, so backend timeouts, failures, and incomplete coverage still produce an auditable journal.

## Run results

The CLI writes one JSON line to stdout:

- `{ "status": "complete", "outcome": "clean" }` or `{ "status": "complete", "outcome": "findings" }` on a finished review, exit code 0.
- `{ "status": "incomplete", "reason": "..." }` on timeouts, backend failures, incomplete coverage, or publication failures, exit code 1.
- Validation errors exit with code 2 and print a message on stderr.

## Required permissions

The calling workflow needs `contents: read` and `pull-requests: write` when the review runs, because publication posts review comments on the pull request.

## Not implemented here

- The credential gateway. `credential-isolation: direct` sends the selected credential through the bootstrap channel without destination pinning. It is a documented escape hatch.
- Local model-runtime lifecycle. The action expects a configured remote or private endpoint.
- Immutable runner-image selection. Callers pin the digest themselves until issue #23 lands.
- The reusable workflow for other repositories. See the [reusable review workflow](reusable-review-workflow.md) contract; issue #22 owns that wrapper.
