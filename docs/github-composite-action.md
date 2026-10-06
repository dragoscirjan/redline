# GitHub composite action

`github/action.yaml` is a composite action. It builds the review context bundle for a pull request's exact base and head commits and, when review inputs are supplied, runs the harness review and uploads its output as artifacts.

## Inputs

Inputs are fixed enums and data. No input accepts free-form review instructions.

| Input | Values | Notes |
| --- | --- | --- |
| `backend` | `pi`, `opencode`, `echo` | The review harness. `echo` is the deterministic test harness. Required together with `model-config` and `model-auth` to enable review execution. |
| `model-config` | JSON | Provider-neutral model configuration: `provider`, `endpoint`, `model`. See [runnable review configuration](/runnable-review-configuration). |
| `model-auth` | JSON secret | Provider-keyed credential map; bind to `secrets.MODEL_CREDENTIALS`. Only the selected provider's credential reaches the harness. |
| `finding-scope` | `defects`, `defects-and-risks` | Default `defects`. |
| `timeout` | duration | Review deadline per run, for example `10m` or `2h`. Capped at 360m. Default `30m`. |
| `artifact-name` | name | Base name for artifacts. Default `redline-review-<run id>`. |
| `artifact-retention-days` | 1–90 | Default `45`. |

Review execution is enabled only when `backend`, `model-config`, and `model-auth` are all supplied. Without them the action keeps the context-bundle-only behavior.

## Pipeline

1. **Validate action inputs** — the event must be a `pull_request` with full base and head commit identifiers; the artifact settings and the all-or-nothing review-input rule are enforced.
2. **Build trusted TypeScript** — the action checkout (the trusted base revision for `pull_request` events) is installed and built; pull request code is never installed, built, or executed.
3. **Validate action inputs with trusted TypeScript** — the review CLI runs `--validate-only` against the `REDLINE_*` environment contract; invalid optional inputs fail even in context-only mode.
4. **Fetch pull request commits as data** — base and head commits are fetched as Git objects and verified.
5. **Build review context bundle** — `src/context-bundle.sh` produces the manifest, diffs, base files, and a source-at-head export; a PR requirements file is folded in when present.
6. **Upload review context artifact** — `<artifact-name>-context` with `source-at-head/` and `review/`.
7. **Run harness review** — the review CLI loads the bundle, runs one prompt per reviewed file through the harness, validates every finding, and writes per-file review records.
8. **Upload review output artifact** — `<artifact-name>-reviews` with the per-file JSON and Markdown records and the run summary.

## Boundaries

- Pull request content is untrusted data. The harness receives it only inside a delimited context block with an explicit untrusted-data framing; it never alters the fixed policy.
- The harness runs with tools disabled and a constructed environment; no GitHub token or ambient credentials reach it.
- Model output must validate against the authoritative diff — path, side, line, and byte-identical evidence — or the finding is rejected. Persisted reasons and raw model output are redacted against the selected credential before artifacts are written.
- In context-only mode (review inputs empty) the action uploads only `<artifact-name>-context`; the `<artifact-name>-reviews` artifact is produced only when review execution is enabled.
- Release tags must contain the built `dist/` output of the exact reviewed source; the action verifies it exists and builds nothing from pull request revisions.

See [runnable review configuration](/runnable-review-configuration) for the environment contract, [harness executor](/harness-executor) for harness specifics, and [review output](/review-reporting) for the record schema.
