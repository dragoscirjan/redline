# Local Git review CLI

The local CLI reviews Git changes without a forge, pull request, remote URL, or publication token. It uses the same fixed prompts, harness isolation, diff evidence validation, and JSON/Markdown artifacts as the GitHub integration. It does not apply fixes or execute repository code.

## Install

Requires Node.js 24 and Git on the trusted host. Release compatibility requires native execution tests on Linux, macOS, and Windows, each on x64 and ARM64. The CI matrix verifies the actual Node platform/architecture and runs local capture, context-builder contracts, reporting, cancellation, and installed-package tests on all six targets. External indexer compatibility is separate from these CLI tests. A target is not considered verified until its job passes. npm publishing requires successful CI for the exact main commit.

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

Shallow clones work when the selected refs and required common ancestor are available locally. Redline preserves the shallow boundary in its scratch metadata, including for linked worktrees and synthetic working-tree snapshots. It accepts only a bounded regular metadata file containing at most 20,000 commit IDs in the repository's object format, rejects symlinks and concurrent boundary changes, and leaves the original boundary and index unchanged. It never fetches or deepens history; unavailable ancestry still fails the comparison.

For an exact tree comparison:

```bash
redline review --base main --head feature --comparison direct --harness echo
```

Tags, object IDs, detached HEADs, and remote-tracking refs work as local Git revisions. A dirty working tree does not affect a committed-revision review. Reflog selectors and auxiliary pseudo-refs such as `FETCH_HEAD` are not exported into scratch metadata; resolve them to a commit ID first. A repository must already have a committed `HEAD`.

## Indexed cross-file context

Indexing is enabled by default, with CGC 0.5.7 as the default provider. Like the GitHub action, Redline indexes the captured **base** snapshot and resolves bounded related callers, tests, and contracts from captured **head** source. Working-tree reviews use their synthetic revision IDs; later live edits cannot alter these inputs. Newly added or unsupported files have no supported base-graph anchor. The local CLI additionally attempts bounded static-head discovery described below; remaining gaps stay explicit.

```bash
redline review --base main --head HEAD --harness pi
redline review --base main --head HEAD --harness pi --indexing required
redline review --base main --head HEAD --harness echo --indexing disabled
```

- `enabled`: attempt indexing; retain explicit file-only coverage on unavailable providers, unsupported files, missing relationships, or invalid source evidence.
- `required`: stop **before model review** if any reviewed file lacks a usable, source-validated related span. This can reject changes containing new files or documentation. It does not claim complete semantic coverage.
- `disabled`: do not discover or run an indexer.

The external provider and Python 3.12+ helper runtime must already be installed on the trusted host. Redline does not download, install, upgrade, or downgrade them. CGC must report exactly 0.5.7. An already-provisioned, checksum-matching Linux x64 binary at `$XDG_STATE_HOME/redline/tools/cgc/0.5.7/linux-x64/cgc` (or `$HOME/.local/state/...`) takes precedence over PATH; an explicit `--index-executable PATH` takes precedence over both. A mismatched global version is not silently replaced.

`--index-runtime PATH` selects an existing Python executable; otherwise Redline searches trusted PATH directories for `python3` or `python`. Indexers, runtimes, and Node entrypoints must resolve outside the reviewed repository. GitNexus 1.6.12 is an explicit opt-in through `--indexing-provider gitnexus`; check its PolyForm Noncommercial license before use. CGC remains the default. Native provider assets and database backends do **not** have proven support on all six CLI targets. A provider that cannot run yields explicit unavailable coverage, not a claim of cross-platform compatibility.

An existing artifact can be imported without running an indexer or Python:

```bash
redline review --base main --head HEAD --harness pi \
  --code-context /absolute/path/to/code-context.json \
  --code-context-repository owner/repository
```

Replace the path and namespace with the artifact's actual values. Without `--code-context-repository`, the expected namespace is `local/<opaque Git-common-directory hash>` from `capture.json`; no GitHub remote is needed. Import checks namespace, head, optional base identity, supported provider/schema, bounded paths/spans, and captured head source. An import is not trusted merely because it was produced earlier. Provider selection flags apply to building; an imported artifact supplies its own validated provider identity.

Local indexing automatically retains validated base databases under `$XDG_STATE_HOME/redline/indexes/v1` (or `$HOME/.local/state/redline/indexes/v1`), separate from review outputs and pinned tools. Identity includes the local repository namespace, base commit, provider/version, platform/architecture, and index configuration. Head-only changes and token-budget changes do not rebuild a healthy matching base index. Missing, corrupt, incompatible, or unsafe state is rebuilt; an unavailable cache falls back to a fresh per-run index rather than trusting it. The terminal reports `Base index:` with one of these values:

- `reused`: a matching base index was reused.
- `rebuilt`: a base index was built with persistent cache storage.
- `uncached`: fresh per-run indexing was used without persistent cache storage.
- `not-needed`: preparation skipped building a base index.
- `unavailable`: provider-built index preparation was unavailable.
- `imported`: an existing context artifact was selected; its identity, source validation, and coverage are reported separately.

Each run refreshes sanitized base bytes from immutable Git objects at a stable pathname, validates the database through the pinned provider, and queries again. Head evidence and review artifacts are always rebuilt from the new captured head; retaining a graph does not retain model answers. Source export and provider query/startup time therefore remain on warm runs. Per-run head snapshots, socket directories, and provider homes are removed after preparation. The bounded artifact and coverage remain in `index/`.

The private cache retains at most eight completed entries and 2 GiB of managed state, with least-recently-used eviction. Oversized or unsafe entries are not retained. An OS-backed lock serializes local index preparation, so overlapping runs do not publish partial databases or index the same base concurrently. Lock ownership releases on normal completion or process exit; cancelled incomplete builds are discarded. Unknown files are not deleted by cache cleanup. These controls do not establish arbitrary-runner sandboxing.

This establishes context-input parity, not equal indexing latency, model output validity, or finding quality. The default local finding scope remains `defects`; use `--finding-scope defects-and-risks` to match the dogfood workflow's broader scope. Candidate verification remains disabled in both paths.

## Static captured-head context

`--head-context enabled|disabled` defaults to enabled locally, independent of whether an indexer runs. For reviewed text files with no usable base-graph spans, it finds literal relative ESM imports/re-exports and their importing files in captured JavaScript/TypeScript source. This includes test files when they import the changed module. It never runs a resolver, interpreter, test, or repository configuration. Package aliases, dynamic imports, Python imports, runtime resolution, and exhaustive test discovery are not implemented.

Spans carry provider `static-head` version `1`, the captured **head** revision, and an explicit lexical-candidate limitation. They have no graph references and are never proof of reachability. Coverage remains partial. The graph artifact in `index/` still describes only the external provider; review coverage counts the additional source-backed spans and reports `static-head-context`. This fallback does not satisfy `--indexing required`'s provider-context preflight.

Discovery examines at most 512 code files, 256 directories, depth 12, 4,096 entries per directory, 128 KiB per file, 8 MiB total, the first 4,096 lines per file, and 32 literal imports per file. Selection is deterministic; directories exceeding the entry bound are omitted. It selects at most four related files per reviewed file, 40 lines/8 KiB per span, within the existing 24 KiB per-file and 48 KiB run-wide related-source bounds. Missing, unsafe, symlinked, invalid-UTF8 or oversized source is never evidence of absence.

## Resume validated work

Local result reuse defaults to enabled. Repeat the same review command; no previous run path is required:

```bash
redline review --base main --head HEAD --harness pi
redline review --base main --head HEAD --harness pi
# Explicitly bypass result reuse:
redline review --base main --head HEAD --harness pi --reuse disabled
```

The private repository-scoped cache lives in `$XDG_STATE_HOME/redline/results/v1` (or `$HOME/.local/state/...`). It stores only validated clean/findings records, not failures. Completed files can therefore survive a partially failed or interrupted run. An exact semantic fingerprint includes model/endpoint/auth mode, protocol, output allowance, policy/schema, diff, captured source, related context and per-file timeout. Current evidence is revalidated, file IDs/revisions are remapped, and each run rebuilds coverage, verdicts, synthesis and artifacts. A cache hit does not authorize stale publication.

Readers bound restored entries to 2,000 files, 512 KiB per record, and 32 MiB total. Writers reserve the same quotas per loaded cache; concurrent publication uses atomic replacement, so a collision can lose reuse but cannot become an unvalidated success. Unsafe/private-directory failures disable reuse, not review; cache misses, invalid records and changed fingerprints run normally. Existing state parents are never chmod'ed.

Old run directories are not retroactively imported as trustworthy cache records. Reuse starts with records written by this implementation. The v8 prompt-policy change invalidates earlier fingerprints. Terminal output reports both the configured availability and actual reused/executed counts.

## Scheduling and deadlines

After reuse selection, preflight reports uncached file count, worker count, policy, remaining time, and a worst-case bound if every file consumes its full per-file allowance. This is **not** a model-latency or cost forecast. Capture/index time already spent reduces the available review time. Redline never expands timeouts, concurrency or token allowances automatically.

`--scheduling largest-first|mixed` defaults to the existing largest-diff-first policy. `mixed` alternates largest and smallest diffs to start some short work earlier. Both preserve bounded workers and manifest-order artifacts. Serial execution, including gated candidate verification, retains manifest order. Size is only a heuristic; mixed scheduling can improve deadline coverage while increasing makespan. The deterministic experiment in `benchmark/performance/mixed-scheduling/v1/` records that trade-off on one fixed synthetic corpus; it is not live-model evidence.

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

## Output-token budget

`--max-output-tokens COUNT` sets the maximum output tokens for each model invocation. Its environment equivalent is `REDLINE_MAX_OUTPUT_TOKENS`; the trusted user-config key is `"max-output-tokens"` with a string value. Precedence remains CLI → environment → user config. Values must be decimal integers from 1,024 through 262,144; larger explicit values such as `32768` or `65536` are supported. This safety ceiling is not a claim about any model's capacity. Providers can reject requests above their supported limits; Redline does not retry token exhaustion automatically.

```bash
redline review --base main --head HEAD --harness pi --max-output-tokens 32768
```

When unset, Pi retains its benchmark-derived 16,384-token default; OpenCode retains its existing model/provider defaults. An explicit setting configures Pi's isolated model `maxTokens` and OpenCode's runtime output ceiling, without changing OpenCode's model context-window metadata. OpenCode's catalog/provider may impose a lower model limit. Echo makes no model call; it validates and records the selection for integration tests.

Output tokens are not bytes, words, context-window capacity, a whole-run allowance, or a dollar budget. Reasoning can consume this allowance depending on the provider. This setting does not allocate separate reasoning tokens or reserve tokens for final JSON, and does not promise syntactically valid output. Timeouts remain independent. Higher token allowances can increase cost and memory use: retained harness stdout remains separately bounded at 8–64 MiB (16 MiB for a 32,768-token allowance); persisted diagnostics and prompt bounds remain unchanged. An explicit token allowance participates in semantic review-cache fingerprints and is recorded in local `status.json` and terminal output.

## Model request protocol

`--model-protocol compatible|openrouter-json` defaults to `compatible`, preserving existing provider behavior. Pi's `thinking off` metadata alone does not establish that an endpoint disabled reasoning.

For an explicit Pi/OpenRouter probe:

```bash
redline review --base main --head HEAD --harness pi \
  --provider openrouter --endpoint https://openrouter.ai/api/v1 \
  --model z-ai/glm-5.3-flash --max-output-tokens 32768 \
  --model-protocol openrouter-json --scheduling mixed
```

The profile sends `reasoning: {enabled:false}`, `provider: {require_parameters:true}`, and a strict JSON Schema generation request for the fixed v4 discovery document. Tools remain disabled and sampling remains provider-default. The schema requires a concise reason even on clean results and excludes null optional fields; guidance findings omit proposed replacement text. Core JSON, schema, source/diff and impact-reference validation still runs independently. Other prompts without a supplied schema use JSON-object formatting.

Selecting this profile with another harness/provider fails before model execution; it never silently downgrades. An unsupported endpoint, model, schema feature or upstream provider can reject the request. Loopback tests verify actual wire fields, not that every upstream honors them or that findings are correct. There is no repair model call, silent JSON repair, or retry for rejected/malformed output. Separate reasoning allocation and reserved final-answer tokens remain unimplemented.

The new local flags have corresponding `REDLINE_REUSE`, `REDLINE_HEAD_CONTEXT`, `REDLINE_SCHEDULING` and `REDLINE_MODEL_PROTOCOL` settings and same-named string keys in trusted user configuration. They do not change the legacy GitHub Action environment contract.

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
- `--indexing enabled|disabled|required`: default `enabled`.
- `--indexing-provider cgc|gitnexus`: default `cgc`.
- `--index-executable PATH`, `--index-runtime PATH`: trusted existing provider/Python overrides.
- `--code-context PATH`, `--code-context-repository ID`: optional artifact import and expected namespace.
- `--harness pi|opencode|echo`: default `pi`.
- `--provider`, `--endpoint`, `--model`, `--auth none`: trusted model selection.
- `--reuse enabled|disabled`: default `enabled`; exact validated-result reuse.
- `--head-context enabled|disabled`: default `enabled`; bounded static-head source candidates.
- `--scheduling largest-first|mixed`: default `largest-first`.
- `--model-protocol compatible|openrouter-json`: default `compatible`; explicit Pi/OpenRouter wire controls.
- `--max-output-tokens COUNT`: optional per-call generation cap, `1024`–`262144`; Pi defaults to `16384` when unset.
- `--timeout`: per-file deadline, default `4m`.
- `--run-timeout`: whole-run deadline including capture, indexing, and review, default `10m`. Local context preparation has an additional five-minute ceiling within that budget.
- `--concurrency`: integer `1`–`8`, default `4`.
- `--finding-scope defects|defects-and-risks`: default `defects`.
- `--fail-on none|findings|high|critical`: default `none`.

Planned VCS and reporter IDs are recognized but rejected during capability preflight, before capture, output creation, or model calls. They never silently fall back to Git or terminal reporting. Forge-specific settings and the editor JSON-RPC protocol belong to their later epics; no invented credentials or editor flags are accepted here.

## Output and exit status

Default artifact location: `$XDG_STATE_HOME/redline/reviews/run-*`, or `$HOME/.local/state/redline/reviews/run-*`. Each invocation creates a private new run directory. Redline never overwrites a previous run.

- `bundle/`: authoritative manifest, diffs, base files, and commit metadata.
- `source/`: captured bounded head files, never a live worktree.
- `capture.json`: requested and resolved revisions, snapshot identity, capture coverage, excluded untracked paths, and inert symlink path/target data.
- `index/code-context.json`, `index/status.json`: bounded normalized context and actual source-validated coverage when indexing/import is enabled.
- `reviews/`: existing validated file records, summary, and consolidated review as JSON and Markdown.
- `status.json`: local completion, failure, cancellation, or deadline classification and exit code.

Review schemas remain unchanged. Synthetic working-copy commit IDs and the index digest identify captured states, not user commits. Bundle/evidence selection is deterministic; existing operational durations and telemetry still vary between runs.

Interactive stderr uses one updating, width-bounded dot strip in manifest order, with completed/total and running counts. Green means a validated clean file; red means findings; gray means intentionally inert/excluded; yellow `!` means a failed or omitted review. Waiting/running files use outlined dots. Failures never appear as inert or clean. Without colors, distinct symbols (`+`, `x`, `-`, `!`, `o`, `.`) retain these meanings. Redirected output has no animation or automatic ANSI colors and does not emit per-file start/completion lines.

Final output states complete/incomplete review coverage, indexed-context status/provider/usable span counts, verdict, grouped failure counts, and the artifact path. File-only fallbacks are reported before model review; they are not labeled as indexed coverage. Findings are grouped by filename, with severity, side, line span, explanation, and an excerpt from the authoritative captured diff. Old/new line numbers are preserved and `>` marks cited changed lines. Each excerpt is capped at 20 lines and clearly marked when clipped or unavailable. The reader revalidates the bundle revisions, file identity, evidence, and span endpoints; it never substitutes model text for missing diff context. Existing proposed fixes are shown separately, capped at 20 lines, and labeled as not applied or test-verified. A missing fix is reported explicitly, not invented.

Terminal data is control-character filtered, bounded, and credential-redacted before coloring. Tabs are displayed as four spaces; authoritative source and diff bytes remain unchanged. Only these bounded reviewed-diff excerpts and proposed-fix blocks are displayed—not full source payloads, prompts, raw model output, reasoning, or publication tokens. Source and bounded redacted model artifacts remain on disk under the existing artifact contract; protect the output directory accordingly.

| Exit | Meaning |
| --- | --- |
| `0` | Completed; findings do not fail by default |
| `1` | Operational failure, required context unavailable, deadline exhaustion, or incomplete required file review |
| `2` | Usage/configuration error |
| `3` | Completed review meets the explicit finding failure threshold |
| `4` | Selected VCS/reporter capability unavailable |
| `5` | Reporter failed after review artifacts were written |
| `130` | Interrupted/cancelled |

`--fail-on high` includes high and critical findings. Incomplete reviews fail regardless of the finding threshold. Reporter failure cannot erase review artifacts or stop other reporters. Preflight configuration failure stops before review execution.

SIGINT and SIGTERM cancel capture, active indexers, and active harness processes. Unix uses process-group termination; Windows uses the OS process-tree termination tool for the spawned process IDs. No shell is used to launch a harness. Node-based npm harness shims are resolved to their installed JavaScript entrypoints rather than executing Windows command scripts. Temporary Git/harness scratch cleanup is attempted on handled exit paths. If revision-snapshot disposal fails, the CLI prints a content-free warning without replacing the completed review result or the original execution/cancellation error; cleanup is not claimed to have succeeded. Interrupted runs can retain partial artifacts and `status.json`; they are never presented as complete reviews. Force-killing the Redline process cannot guarantee cleanup.

## Bounds and trust

Git capture permits at most 20,000 tree/index entries, 16 MiB per captured working file or Git command output, and 256 MiB each for aggregate captured source, working-tree content, and bundle output. Every Git command has a 30-second ceiling and also observes whole-run cancellation. Head source embeds only files up to the existing 128 KiB source-file bound; larger files are not copied into `source/`. The review prompt retains the existing 64 KiB embedded side and 512 KiB total untrusted-payload bounds.

Git commands use absolute trusted executables, argument arrays, a constructed environment, no lazy fetches, and scratch metadata without repository hooks, filters, text converters, credentials, or external diff configuration. Symlinks are captured as path/target data and are never installed into the source export. Redline never runs project builds, tests, installers, scripts, or executables.

This is a trusted-host CLI, not a sandbox for arbitrary untrusted runners. Docker/Podman and the credential gateway remain separate future work. Candidate verification remains disabled; this CLI does not activate its independent quality gate.

## Release operations

`Release npm CLI` is a manual workflow on `main`. Before its first run, the owner must configure the `npm-release` GitHub environment with required reviewers and register this repository/workflow/environment as the npm trusted publisher for `@dragoscirjan/redline`. First-package registration or initial publication can require a separate owner bootstrap in npm; the workflow does not bypass npm account policy.

The requested version must match `package.json` and must not already exist in npm. Registry/network errors fail closed. The exact main commit must have successful CI, including all harness jobs. The workflow re-runs type checking, tests (including offline tarball installation), and docs before publishing with OIDC provenance. There is no installer hook, runtime dependency installation, or emitted-JavaScript build step.

`mise run validate` includes packed-package installation tests. No package has been published merely because those tests pass. Publication and merges require separate owner approval.
