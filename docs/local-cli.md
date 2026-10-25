# Local Git review CLI

The local CLI reviews Git changes without a forge, pull request, remote URL, or publication token. It uses the same fixed prompts, harness isolation, diff evidence validation, and JSON/Markdown artifacts as the GitHub integration. It does not apply fixes or execute repository code.

## Install

Requires Node.js 24 and Git on the trusted host. Release compatibility requires native execution tests on Linux, macOS, and Windows, each on x64 and ARM64. The CI matrix verifies the actual Node platform/architecture and runs local capture, reporting, cancellation, and installed-package tests on all six targets. A target is not considered verified until its job passes. npm publishing requires successful CI for the exact main commit.

After an approved npm release:

```bash
npm install --global --ignore-scripts @dragoscirjan/redline@VERSION
redline --help
```

Replace `VERSION` with an existing immutable package version. Package publication is manual; adding the package and release workflow does not publish it. For a source-checkout trial, use `node bin/redline.mjs` instead of `redline`.

Pi or OpenCode must be installed separately on a trusted PATH outside the reviewed repository. Redline never installs a harness or project dependency. The `echo` harness needs neither a model service nor a credential and always returns a clean review; use it only to check integration, not review quality.

## Compare branches

```bash
redline review --base main --head feature \
  --harness pi --provider openrouter \
  --endpoint https://openrouter.ai/api/v1 --model z-ai/glm-5.3-flash
```

Supply credentials through `REDLINE_MODEL_AUTH`, a provider-keyed JSON object populated by your secret manager or trusted user configuration. There is no command-line credential option. This is an npm CLI, not an executable with an embedded Node/Bun runtime; Node.js is installed separately. The command does not fetch: refs and objects must already exist locally.

By default, Redline resolves the common ancestor of `main` and `feature` and reviews that ancestor against `feature`. Both user refs are pinned to immutable commit IDs before capture. Multiple merge bases fail rather than choosing arbitrarily.

For an exact tree comparison:

```bash
redline review --base main --head feature --comparison direct --harness echo
```

Tags, object IDs, detached HEADs, and remote-tracking refs work as local Git revisions. A dirty working tree does not affect a committed-revision review. Reflog selectors and auxiliary pseudo-refs such as `FETCH_HEAD` are not exported into scratch metadata; resolve them to a commit ID first. A repository must already have a committed `HEAD`.

## Review uncommitted changes

```bash
redline review --harness echo
redline review --worktree staged --harness echo
redline review --worktree unstaged --harness echo
redline review --worktree all --untracked include --harness echo
```

| Mode | Baseline | Captured head |
| --- | --- | --- |
| No target / `all` | `HEAD`, or explicit `--base` | Index selection overlaid with tracked working-tree content |
| `staged` | `HEAD`, or explicit `--base` | Exact stage-zero index objects |
| `unstaged` | Captured index tree | Tracked working-tree content |

For `unstaged`, `--base` pins the committed eligibility-policy source and the parent identity of the synthetic index baseline; it does not replace the index comparison baseline. A staged deletion with an untracked file at the same path remains excluded unless untracked inclusion is requested.

Untracked files are excluded by default to reduce accidental disclosure. Their paths are recorded in `capture.json`; they do not enter review prompts. `--untracked include` captures eligible files subject to the same bounds and exclusions. Git-ignored files remain ignored. Untracked inclusion is incompatible with staged-only review.

Working-tree bytes are captured literally: repository clean filters and automatic line-ending normalization are not run. This can expose normalization-only differences that ordinary filtered Git comparisons hide.

The original index and working tree are not changed. Synthetic trees and commits are written only to temporary Redline object storage. File bytes are read twice and compared; the index bytes, HEAD identity, and untracked selection are checked for concurrent mutation. Detected ambiguity fails the capture. This is not a filesystem transaction or a continuous watch: later edits do not change an already-captured review.

On Windows, tracked executable/symlink modes come from the Git index rather than Unix permission bits; stage mode/type changes explicitly. Unmerged indexes, intent-to-add entries, sparse indexes, and paths beneath directory symlinks are rejected. Stage or materialize these states before reviewing. Submodules are inert gitlink objects; nested working-copy changes are not traversed.

## Configuration

Precedence:

1. Explicit non-secret command arguments.
2. Supported `REDLINE_*` environment settings.
3. Trusted user configuration.
4. Built-in defaults.

Default user configuration: `$XDG_CONFIG_HOME/redline/config.json`, or `$HOME/.config/redline/config.json`. `--config PATH` selects another trusted user file. The file must be outside the reviewed repository, bounded to 64 KiB, regular, and not a symlink. If it contains `model-auth`, Unix permissions must exclude group and other access (use `chmod 600`).

Example for a credential-less local endpoint:

```json
{
  "harness": "pi",
  "model-config": {
    "provider": "local",
    "endpoint": "http://127.0.0.1:1234/v1",
    "model": "local-model",
    "auth": "none"
  },
  "concurrency": "2",
  "timeout": "4m"
}
```

Scalar configuration options use strings. The user file accepts the review flags except `repository` and `config`; `reporter` accepts a string or list. `model-config` accepts an object; `model-auth` accepts a provider-keyed credential object. `repository` is selected only by `--repository`, `REDLINE_REPOSITORY_PATH`, or the current directory.

`REDLINE_MODEL_CONFIG` accepts the existing model JSON contract. Individual `--provider`, `--endpoint`, and `--model` values override its fields. Local endpoints can use `--auth none`; do not also supply `REDLINE_MODEL_AUTH` for credential-less profiles.

Other environment names mirror their scalar flags using uppercase and underscores, with these exceptions:

- `REDLINE_REPOSITORY_PATH`: repository path.
- `REDLINE_HEAD_REVISION`: committed target, not publication head metadata.
- `REDLINE_OUTPUT_DIR`: output directory.
- `REDLINE_REVIEW_CONCURRENCY`: worker count.
- `REDLINE_REPORTER`: comma-separated reporter IDs.

Repository configuration cannot choose model endpoints, executables, credentials, output paths, or reporters. The only repository policy consumed is the existing strict `.redline/review-eligibility.json` from the resolved committed base. Uncommitted policy cannot hide its own changes. There is no additional project config loader.

## Arguments

Run `redline review --help` for the complete contract.

- `--repository PATH`: default current repository; subdirectories resolve to the Git root.
- `--vcs git|jj|mercurial`: only `git` works today.
- `--base REV`: default `HEAD`.
- `--head REV` or `--worktree staged|unstaged|all`: mutually exclusive.
- `--comparison merge-base|direct`: committed comparisons only; default `merge-base`.
- `--untracked exclude|include`: working-tree reviews only; default `exclude`.
- Repeatable `--reporter cli|github|forgejo|gitea|gitlab|bitbucket`: only `cli` works today; default `cli`. Duplicates are rejected.
- `--output PATH`: a new directory outside the reviewed repository, with an existing parent.
- `--color auto|always|never`: default `auto`. A defined `NO_COLOR` disables colors, and `TERM=dumb` disables live terminal redraw and colors.
- `--harness pi|opencode|echo`: default `pi`.
- `--provider`, `--endpoint`, `--model`, `--auth none`: trusted model selection.
- `--timeout`: per-file deadline, default `4m`.
- `--run-timeout`: whole-run deadline including capture, default `10m`.
- `--concurrency`: integer `1`–`8`, default `4`.
- `--finding-scope defects|defects-and-risks`: default `defects`.
- `--fail-on none|findings|high|critical`: default `none`.

Planned VCS and reporter IDs are recognized but rejected during capability preflight, before capture, output creation, or model calls. They never silently fall back to Git or terminal reporting. Forge-specific settings and the editor JSON-RPC protocol belong to their later epics; no invented credentials or editor flags are accepted here.

## Output and exit status

Default artifact location: `$XDG_STATE_HOME/redline/reviews/run-*`, or `$HOME/.local/state/redline/reviews/run-*`. Each invocation creates a private new run directory. Redline never overwrites a previous run.

- `bundle/`: authoritative manifest, diffs, base files, and commit metadata.
- `source/`: captured bounded head files, never a live worktree.
- `capture.json`: requested and resolved revisions, snapshot identity, capture coverage, excluded untracked paths, and inert symlink path/target data.
- `reviews/`: existing validated file records, summary, and consolidated review as JSON and Markdown.
- `status.json`: local completion, failure, cancellation, or deadline classification and exit code.

Review schemas remain unchanged. Synthetic working-copy commit IDs and the index digest identify captured states, not user commits. Bundle/evidence selection is deterministic; existing operational durations and telemetry still vary between runs.

Interactive stderr uses one updating, width-bounded dot strip in manifest order, with completed/total and running counts. Green means a validated clean file; red means findings; gray means intentionally inert/excluded; yellow `!` means a failed or omitted review. Waiting/running files use outlined dots. Failures never appear as inert or clean. Without colors, distinct symbols (`+`, `x`, `-`, `!`, `o`, `.`) retain these meanings. Redirected output has no animation or automatic ANSI colors and does not emit per-file start/completion lines.

Final output states complete/incomplete coverage, verdict, grouped failure counts, and the artifact path. Findings are grouped by filename, with severity, side, line span, explanation, and an excerpt from the authoritative captured diff. Old/new line numbers are preserved and `>` marks cited changed lines. Each excerpt is capped at 20 lines and clearly marked when clipped or unavailable. The reader revalidates the bundle revisions, file identity, evidence, and span endpoints; it never substitutes model text for missing diff context. Existing proposed fixes are shown separately, capped at 20 lines, and labeled as not applied or test-verified. A missing fix is reported explicitly, not invented.

Terminal data is control-character filtered, bounded, and credential-redacted before coloring. Only these bounded reviewed-diff excerpts and proposed-fix blocks are displayed—not full source payloads, prompts, raw model output, reasoning, or publication tokens. Source and bounded redacted model artifacts remain on disk under the existing artifact contract; protect the output directory accordingly.

| Exit | Meaning |
| --- | --- |
| `0` | Completed; findings do not fail by default |
| `1` | Operational failure, deadline exhaustion, or incomplete required file review |
| `2` | Usage/configuration error |
| `3` | Completed review meets the explicit finding failure threshold |
| `4` | Selected VCS/reporter capability unavailable |
| `5` | Reporter failed after review artifacts were written |
| `130` | Interrupted/cancelled |

`--fail-on high` includes high and critical findings. Incomplete reviews fail regardless of the finding threshold. Reporter failure cannot erase review artifacts or stop other reporters. Preflight configuration failure stops before review execution.

SIGINT and SIGTERM cancel capture and active harness processes. Unix uses process-group termination; Windows uses the OS process-tree termination tool for the spawned process IDs. No shell is used to launch a harness. Node-based npm harness shims are resolved to their installed JavaScript entrypoints rather than executing Windows command scripts. Temporary Git/harness scratch directories are removed on handled exit paths. Interrupted runs can retain partial artifacts and `status.json`; they are never presented as complete reviews. Force-killing the Redline process cannot guarantee cleanup.

## Bounds and trust

Git capture permits at most 20,000 tree/index entries, 16 MiB per captured working file or Git command output, and 256 MiB each for aggregate captured source, working-tree content, and bundle output. Every Git command has a 30-second ceiling and also observes whole-run cancellation. Head source embeds only files up to the existing 128 KiB source-file bound; larger files are not copied into `source/`. The review prompt retains the existing 64 KiB embedded side and 512 KiB total untrusted-payload bounds.

Git commands use absolute trusted executables, argument arrays, a constructed environment, no lazy fetches, and scratch metadata without repository hooks, filters, text converters, credentials, or external diff configuration. Symlinks are captured as path/target data and are never installed into the source export. Redline never runs project builds, tests, installers, scripts, or executables.

This is a trusted-host CLI, not a sandbox for arbitrary untrusted runners. Docker/Podman and the credential gateway remain separate future work. Candidate verification remains disabled; this CLI does not activate its independent quality gate.

## Release operations

`Release npm CLI` is a manual workflow on `main`. Before its first run, the owner must configure the `npm-release` GitHub environment with required reviewers and register this repository/workflow/environment as the npm trusted publisher for `@dragoscirjan/redline`. First-package registration or initial publication can require a separate owner bootstrap in npm; the workflow does not bypass npm account policy.

The requested version must match `package.json` and must not already exist in npm. Registry/network errors fail closed. The exact main commit must have successful CI, including all harness jobs. The workflow re-runs type checking, tests (including offline tarball installation), and docs before publishing with OIDC provenance. There is no installer hook, runtime dependency installation, or emitted-JavaScript build step.

`mise run validate` includes packed-package installation tests. No package has been published merely because those tests pass. Publication and merges require separate owner approval.
