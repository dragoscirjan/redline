# Local Git review CLI

This is the detailed reference. For a short setup path, start with [Get started](/get-started/). For copyable recipes, use [Common commands](/commands). Programmatic clients can use the [stdio JSON-RPC protocol](./stdio-protocol.md).

The local CLI reviews Git changes without a forge, pull request, remote URL, or publication token. It uses the same fixed review policy, diff evidence validation and JSON/Markdown artifacts as the GitHub integration. Current source invokes native Pi/OpenCode with their normal global and checkout-local configuration. This native behavior is not in published 1.2.2.

**Unsandboxed CLI warning:** configured MCP servers and plugins can execute commands, modify files, access the network and use available credentials. Redline does not sandbox them. Use a container, VM or other isolation when needed. The existing GitHub Action remains isolated until its separate Docker migration. The CLI always prints its unsandboxed warning, including when a caller supplies `container=redline`; that environment value does not prove isolation. An externally started container can still provide its own boundary.

## Install

Requires Node.js 24 and Git on the trusted host. Release compatibility requires native execution tests on Linux, macOS, and Windows, each on x64 and ARM64. The CI matrix verifies the actual Node platform/architecture and runs local capture, context-builder contracts, reporting, cancellation, and installed-package tests on all six targets. Native harness and external indexer compatibility are separate from these CLI tests. Direct harness execution requires a native executable entry point supported by the host; npm `.cmd` shims are not interpreted by a shell. On Windows, Redline can resolve a trusted npm-installed Pi entry point and invoke it through Node with an argument prefix, outside the reviewed repository. The new native CLI/Docker integration has local Linux amd64 evidence, not new ARM64 or Windows harness evidence. A target is not considered verified until its job passes. npm publishing requires successful CI for the exact main commit.

Install a published version:

```bash
npm install --global --ignore-scripts @dragoscirjan/redline@VERSION
redline --help
```

Replace `VERSION` with an existing immutable package version. Eligible versions are published by main CI; passing local tests alone does not publish a package. For a source-checkout trial, install the locked dependencies and run `pnpm run build`, then use `node bin/redline.mjs` instead of `redline`. `REDLINE_ENV=node` is the default and runs compiled JavaScript. `REDLINE_ENV=bun` selects Bun source execution through the same JavaScript entrypoint. See [runtime selection](/get-started/#choose-the-runtime).

Pi or OpenCode must be installed separately on a trusted PATH outside the reviewed repository. Redline never installs a harness or project dependency. The `echo` harness needs neither a model service nor a credential and always returns a clean review; use it only to check integration, not review quality.

## Native model warmup

Before file analysis, native CLI/Docker execution runs a bounded warmup through the selected harness and model. Warmup policy v3 checks context-mode and sequential-thinking as optional tools. Neither receives code-index status or file counts. Missing, disabled or disconnected tools warn without preventing review.

`--indexing-provider cgc|gitnexus` selects the code indexer, defaulting to CGC while indexing is enabled. `--indexing disabled` selects no indexer. The model checks only the selected provider, using native MCP discovery or an installed CLI version probe. A missing/unusable provider warns and review continues from captured source. Redline does not install tools or manually start/probe native servers. Native automatic indexing no longer also runs the separate precomputed CLI pipeline before warmup. Explicit `--code-context` imports and isolated context preparation retain their existing validation/cache contracts.

When the selected indexer is available, the warmup model must actually index the supplied captured head source or validate reuse of its exact index, wait for completion, and execute a relevant query. `reviews/warmup.json` separates tool availability from indexer status and records index/reuse and query observations. Unsupported prose such as "indexed 120 files" is not accepted as an executed operation or file count. Readiness requires observed successful index/reuse and query calls, positive model-reported counts and shared persistence. Those observations still do not prove complete graph coverage or correct query semantics.

Pi connects non-direct MCP servers in the background. Warmup requests discovery through codemode's `ALL_TOOLS`/`searchTools()` or `tool_search`, which waits for those connections without changing exposure or permissions. For OpenAI-compatible Pi requests, the first warmup request requires a declared native discovery tool, or another native tool when discovery helpers are unavailable. Warmup does not impose final-answer JSON formatting on its tool-using requests; the report schema is in the prompt. OpenCode retains its native tool selection. Both harnesses pass the same execution-evidence checks.

The warmup has a two-minute ceiling, at most one quarter of the remaining whole-run time, and a separate 4,096-token generation cap per request. One bounded corrective invocation is allowed when the first report does not establish the work. Both share the original deadline. Warmup preserves reasoning and native provider retries, can incur charges, and never extends the run budget or changes file-review output allowances. An incomplete, invalid, failed or timed-out warmup for an observed selected provider stops file analysis instead of skipping its required checks. An optional indexer with no observed or reported callable tools can remain unverified and warn while file analysis continues, even when no probe or index operation was observed. This fallback accepts no indexing readiness or file count. A completed probe reporting the provider missing/unusable warns and continues; an attempted index reported as partial also warns and degrades. `--indexing required` additionally stops unless setup establishes reusable readiness. Optional context/reasoning tools never block review, and confirmed shared model/credential/request failures always stop requests.

Warnings appear before file work. Invalid JSON cannot erase observed catalog visibility, and schema errors identify fields without retaining invalid values or raw warmup output. Extra native tools, permissions and configuration remain unchanged. Never execute repository scripts, builds, tests or installers to prepare an index.

## Native code-impact checks

Native file prompts identify the selected ready indexer and query tool. Each fresh file process must confirm a query before claiming indexed impact checks. Pi requests that tool on its first OpenAI-compatible review request when directly declared, otherwise requests native discovery. No index is rebuilt per file.

Reviews inspect changed functions/contracts and their incoming callers, including unchanged callers outside the diff. A concrete compatibility defect belongs in the findings, anchored to changed lines, with unchanged caller citations in `supportingEvidence` and the path in `impactPath`. An unchanged caller alone is not a defect.

Every native response also supplies `impactAnalysis`, persisted in per-file JSON/Markdown and the run summary. It lists changed symbols, caller citations validated against captured head source, a bounded consequence and explicit limitations. Caller citations from the base revision are rejected, even if their historical source evidence is valid. Missing or forged citations fail validation. A claimed indexed check without an observed successful selected query becomes partial, not a verified impact claim. Clean results can still document compatible callers without creating informational findings. This does not prove exhaustive graph coverage or live-model review quality.

## Optional analysis tools

Pi and OpenCode load their own global and checkout-local MCP configuration, tools, plugins and permissions. Redline invokes the installed CLI entry point directly, does not replace the user's home/configuration directories, and does not filter extra configured MCPs. The harness controls connection and tool discovery. Redline never installs a missing server during review.

Inspect configuration with the harness's own commands, such as `pi mcp list --json` or `opencode mcp list`. Pi's listing command reads project configuration only for already-trusted projects; native review grants trust for its invocation without changing the user's persistent trust configuration.

Native reports use `reviews/native-tools.json` and per-file `tools` metadata. They distinguish observed names, server connection states, calls and successful results. A connected server does not prove that it has indexed the repository. A server or tool that was not observed is not labelled an unsupported installation. Missing requested integrations warn without blocking other configured tools. Tool arguments, results and reasoning are excluded from this diagnostic metadata.

Precomputed `--indexing` context is a separate input preparation step. Its status does not control the native harness's MCPs. See [native harness execution](/harness-executor#native-cli-and-docker); the [read-only bridge](/harness-executor#optional-read-only-analysis) remains for isolated Actions.

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

Indexing is enabled by default, with CGC as the default provider. Native Pi/OpenCode prepare captured **head** indexes through the model warmup described above. Isolated/echo execution retains the precomputed pipeline: like the GitHub action, it indexes captured **base** and resolves bounded related callers, tests and contracts from captured **head**. Working-tree reviews use synthetic revision IDs; later live edits cannot alter these inputs. New or unsupported files can lack base-graph anchors. Static-head discovery remains a separate bounded fallback.

```bash
redline review --base main --head HEAD --harness pi
redline review --base main --head HEAD --harness pi --indexing required
redline review --base main --head HEAD --harness echo --indexing disabled
```

- `enabled`: attempt indexing; retain explicit file-only coverage on unavailable providers, unsupported files, missing relationships, or invalid source evidence.
- `required`: native execution requires reusable selected-provider readiness before file analysis, after model warmup. The isolated/precomputed path instead requires a usable source-validated related span for every reviewed file before model review, which can reject new files or documentation. Neither establishes complete semantic coverage.
- `disabled`: do not request code-index preparation. Native configured MCPs and extra tools remain available.

The following pinned-version, Python and cache contract describes isolated/precomputed preparation, not native installation checks. The external provider and Python 3.12+ helper runtime must already be installed on the trusted host. Redline does not download, install, upgrade, or downgrade them. CGC must report exactly 0.5.7. An already-provisioned, checksum-matching Linux x64 binary at `$XDG_STATE_HOME/redline/tools/cgc/0.5.7/linux-x64/cgc` (or `$HOME/.local/state/...`) takes precedence over PATH; an explicit `--index-executable PATH` takes precedence over both. A mismatched global version is not silently replaced.

`--index-runtime PATH` selects an existing Python executable; otherwise Redline searches trusted PATH directories for `python3` or `python`. Indexers, runtimes, and Node entrypoints must resolve outside the reviewed repository. GitNexus 1.6.12 is an explicit opt-in through `--indexing-provider gitnexus`; check its PolyForm Noncommercial license before use. CGC remains the default. Native provider assets and database backends do **not** have proven support on all six CLI targets. A provider that cannot run yields explicit unavailable coverage, not a claim of cross-platform compatibility.

An existing artifact can be imported without running an indexer or Python:

```bash
redline review --base main --head HEAD --harness pi \
  --code-context /absolute/path/to/code-context.json \
  --code-context-repository owner/repository
```

Replace the path and namespace with the artifact's actual values. Without `--code-context-repository`, the expected namespace is `local/<opaque Git-common-directory hash>` from `capture.json`; no GitHub remote is needed. Import checks namespace, head, optional base identity, supported provider/schema, bounded paths/spans, and captured head source. An import is not trusted merely because it was produced earlier. Provider selection flags apply to building; an imported artifact supplies its own validated provider identity.

Local indexing retains validated base databases under `$XDG_CACHE_HOME/redline/indexes/v1` when `XDG_CACHE_HOME` is set. Otherwise it keeps the existing `$XDG_STATE_HOME/redline/indexes/v1` (or `$HOME/.local/state/redline/indexes/v1`) location. Provider data stays separate from review outputs and pinned tools. Identity includes the local repository namespace, base commit, provider/version, platform/architecture, and index configuration. Head-only changes and token-budget changes do not rebuild a healthy matching base index. Missing, corrupt, incompatible, or unsafe state is rebuilt; an unavailable cache falls back to a fresh per-run index rather than trusting it. The terminal reports `Base index:` with one of these values:

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

Spans carry provider `static-head` version `1`, the captured **head** revision, and an explicit lexical-candidate limitation. They have no graph references and are never proof of reachability. Coverage remains partial. The graph artifact in `index/` still describes only the external provider; review coverage counts the additional source-backed spans and reports `static-head-context`. This fallback does not satisfy the isolated/precomputed `--indexing required` provider-context preflight. Native required indexing uses warmup readiness instead.

Discovery examines at most 512 code files, 256 directories, depth 12, 4,096 entries per directory, 128 KiB per file, 8 MiB total, the first 4,096 lines per file, import lines at most 1,024 characters long, and 32 literal imports per file. Selection is deterministic; directories exceeding the entry bound are omitted. It selects at most four related files per reviewed file, 40 lines/8 KiB per span, within the existing 24 KiB per-file and 48 KiB run-wide related-source bounds. Missing, unsafe, symlinked, invalid-UTF8 or oversized source is never evidence of absence.

## Resume validated work

Native Pi/OpenCode reviews disable persisted model-result reuse. User plugins and MCPs can depend on changing external data that a captured-source fingerprint cannot prove unchanged. The terminal states this explicitly. This does not disable the separate validated provider/base-index cache.

The isolated review engine and deterministic echo path retain result reuse. For example:

```bash
redline review --base main --head HEAD --harness echo
redline review --base main --head HEAD --harness echo
# Explicitly bypass result reuse:
redline review --base main --head HEAD --harness echo --reuse disabled
```

For the replayable isolated/echo paths, the private repository-scoped cache lives in `$XDG_STATE_HOME/redline/results/v1` (or `$HOME/.local/state/...`). It stores only validated clean/findings records, not failures. Completed files can therefore survive a partially failed or interrupted run. An exact semantic fingerprint includes model/endpoint/auth mode, protocol, output allowance, policy/schema, diff, captured source, related context, initial per-file timeout, retry policy, available analysis tools and their bounded captured source. Optional tool readiness is checked before reuse matching. When retries are enabled, it also hashes the bounded enriched context, even if the first attempt succeeds. A recovered result cannot be reused after relevant source or retry-policy changes. Current evidence is revalidated, file IDs/revisions are remapped, and each run rebuilds coverage, verdicts, synthesis and artifacts. A cache hit does not authorize stale publication.

Readers bound restored entries to 2,000 files, 512 KiB per record, and 32 MiB total. Writers reserve the same quotas per loaded cache; concurrent publication uses atomic replacement, so a collision can lose reuse but cannot become an unvalidated success. Unsafe/private-directory failures disable reuse, not review; cache misses, invalid records and changed fingerprints run normally. Existing state parents are never chmod'ed.

Old run directories are not retroactively imported as trustworthy cache records. Reuse starts with records written by this implementation. The v8 policy-text and v7 assembler/retry-contract changes invalidate earlier fingerprints. Terminal output reports both the configured availability and actual reused/executed counts.

## Scheduling and deadlines

After reuse selection, preflight reports uncached file count, worker count, policy, remaining time, and a worst-case bound if every file exhausts all configured attempt allowances. This is **not** a model-latency or cost forecast. Capture/index time already spent reduces the available review time. Redline never expands the whole-run deadline, concurrency or token allowances automatically. The local retry policy below explicitly adds two minutes to a file's next attempt after a per-file timeout.

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

Example for a credential-less local endpoint. Configure the selected provider/model in the native harness first; Pi needs its normal model metadata, including context and reasoning capabilities:

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

Redline's own options are not loaded from repository configuration. Its review-eligibility policy still comes from the strict `.redline/review-eligibility.json` at the resolved committed base; uncommitted policy cannot hide its own changes. Separately, native Pi/OpenCode load their normal checkout-local instructions, tools, plugins and MCP settings. These native settings are not a security boundary.

## Review retries and timeouts

```bash
redline review --base main --head HEAD --harness pi \
  --retries 3 --timeout 4m --run-timeout 20m
```

`--retries COUNT` defaults to **3 additional file-review attempts**, up to four attempts total. Values are decimal integers from 0 through 10; `0` disables Redline retries. `REDLINE_RETRIES` and the trusted user-config string key `"retries"` use the same validation. Flags override environment, which overrides user config. These local defaults do not change legacy GitHub Action execution.

Retryable failures are classified transient HTTP/transport errors, Pi's successful-stop zero-token empty provider responses, invalid review documents including JSON/schema, wrong target, evidence or finding-scope failures, per-file timeouts, and model-declared source/excerpt/context omissions. Unknown harness failures, authentication/credit/model/request-configuration failures, token exhaustion, malformed harness streams, capture truncation, cancellation and the whole-run deadline are not retryable. Every new answer is validated independently; retries do not repair JSON or weaken evidence checks. A file still omitted after retries remains incomplete.

The first pass gives every uncached file an initial attempt before retry rounds start. Rounds containing classified upstream failures wait 1s, 2s, 4s, then at most 5s before retrying. The wait is clamped to remaining run time; no request starts if that wait exhausts the deadline. Invalid-output, file-timeout and source-excerpt rounds do not add this delay unless the same round also contains an upstream failure. Local cancellation interrupts the wait. Backoff consumes the existing run budget and never extends it. Each file shares one retry counter across all retryable failure types; switching failure types does not reset it. Worker limits and manifest-order final artifacts stay unchanged. Valid completed results are reused rather than rerun.

`--timeout` is the **initial per-attempt** limit, default `4m`, separate from `--run-timeout`. Only a per-file timeout adds `2m` to that file's next limit. Four consecutive timeouts therefore use limits of `4m`, `6m`, `8m`, `10m`. Invalid output or upstream errors leave the current limit unchanged. `--run-timeout` stays a hard total budget including capture, indexing and all attempts. Each invocation is clamped to remaining time, so not every allowed retry is guaranteed to fit. For example, the four timeout allowances total 28 minutes for one file and cannot all fit into a 20-minute run.

Excerpt retries can include additional base/head source only from the same immutable capture. Small files can become complete within the existing 64 KiB per-side limit; larger files may receive wider surrounding excerpts if they fit. The 128 KiB file-read and 512 KiB complete prompt-payload limits do not grow. If enrichment cannot fit, the original context is retained. Source omissions and truncation remain explicit. The enrichment step reads captured bytes without executing repository code; native configured tools and plugins have their own capabilities.

The retry count measures **Redline review attempts, not HTTP requests**. Pi's adapter retries are disabled in caller-managed mode; native Pi retains its user-configured provider/agent retries. OpenCode 1.18.34 retains five hardcoded native provider retries inside each Redline attempt, so four attempts can issue up to 24 provider requests. OpenCode has no supported disable switch in this integration. Its native requests share the per-attempt timeout and hard whole-run deadline. The CLI warns about this distinction. Isolated loopback fixtures verify fixed harness counts without a paid model; native Pi request counts depend on its user settings.

Per-file JSON records include bounded redacted `attempts` metadata with effective timeouts, source strategy, outcome, error kind and duration. Prior raw answers are not included in that history. File duration totals all attempts. The terminal and run summary report attempts, retried/recovered files, exhausted counters and files lacking time for remaining retries. These counters do not establish finding correctness or live-provider quality.

## Output-token budget

`--max-output-tokens COUNT` sets the maximum output tokens for each model invocation. Its environment equivalent is `REDLINE_MAX_OUTPUT_TOKENS`; the trusted user-config key is `"max-output-tokens"` with a string value. Precedence remains CLI → environment → user config. Values must be decimal integers from 1,024 through 262,144; larger explicit values such as `32768` or `65536` are supported. This safety ceiling is not a claim about any model's capacity. Providers can reject requests above their supported limits; Redline does not retry token exhaustion automatically.

```bash
redline review --base main --head HEAD --harness pi --max-output-tokens 32768
```

When unset, Pi retains its benchmark-derived 16,384-token default; OpenCode retains its existing model/provider defaults. An explicit setting configures Pi's model and native request output limit and OpenCode's runtime output ceiling, without changing OpenCode's model context-window metadata. OpenCode's catalog/provider may impose a lower model limit. Echo makes no model call; it validates and records the selection for integration tests.

Output tokens are not bytes, words, context-window capacity, a whole-run allowance, or a dollar budget. Reasoning can consume this allowance depending on the provider. This setting does not allocate separate reasoning tokens or reserve tokens for final JSON, and does not promise syntactically valid output. Timeouts remain independent. Higher token allowances can increase cost and memory use: retained harness stdout remains separately bounded at 8–64 MiB (16 MiB for a 32,768-token allowance); persisted diagnostics and prompt bounds remain unchanged. An explicit token allowance participates in semantic review-cache fingerprints and is recorded in local `status.json` and terminal output.

## Model request protocol

`--model-protocol compatible|openrouter-json` defaults to `compatible`. Both profiles preserve model/provider reasoning behavior; neither disables reasoning or forces a thinking level.

For an explicit Pi/OpenRouter probe:

```bash
redline review --base main --head HEAD --harness pi \
  --provider openrouter --endpoint https://openrouter.ai/api/v1 \
  --model z-ai/glm-5.3-flash --max-output-tokens 32768 \
  --model-protocol openrouter-json --scheduling mixed
```

The profile preserves provider/model reasoning behavior and sends no reasoning-disable override. It sends `provider: {require_parameters:true}` and a strict JSON Schema generation request for the fixed v4 discovery document. Native tool availability remains controlled by harness configuration; isolated Actions keep their restricted tool policy. Sampling remains provider-default. The schema requires a concise reason even on clean results and excludes null optional fields; guidance findings omit proposed replacement text. Core JSON, schema, source/diff and impact-reference validation still runs independently. Other answer-only prompts without a supplied schema use JSON-object formatting. Tools-first warmup requests are exempt; they carry the report schema in their prompt so setup work can precede the final JSON answer.

Selecting this profile with another harness/provider fails before model execution; it never silently downgrades. An unsupported endpoint, model, schema feature or upstream provider can reject the request. Loopback tests verify actual wire fields, not that every upstream honors them or that findings are correct. There is no separate repair model call or silent JSON repair. Rejected/malformed review documents can receive a fresh attempt under the local retry policy above. Separate reasoning allocation and reserved final-answer tokens remain unimplemented.

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
- `--progress auto|always|never`: default `auto`; `always` keeps the live progress strip when stderr is piped through `tee`. Logs then contain terminal redraw control sequences. `never` suppresses the strip.
- `--color auto|always|never`: default `auto`. A defined `NO_COLOR` disables colors, and `TERM=dumb` disables live terminal redraw and colors.
- `--indexing enabled|disabled|required`: default `enabled`.
- `--indexing-provider cgc|gitnexus`: default `cgc`.
- `--index-executable PATH`: trusted installed-provider path, also supplied to native model warmup. Never point it at repository code.
- `--index-runtime PATH`: Python runtime override for the isolated/precomputed context pipeline, not a native harness-runtime override.
- `--code-context PATH`, `--code-context-repository ID`: optional artifact import and expected namespace.
- `--harness pi|opencode|echo`: default `pi`.
- `--provider`, `--endpoint`, `--model`, `--auth none`: trusted model selection.
- `--reuse enabled|disabled`: default `enabled` for replayable isolated/echo execution; native Pi/OpenCode disable model-result reuse because external tool state cannot be validated.
- `--head-context enabled|disabled`: default `enabled`; bounded static-head source candidates.
- `--scheduling largest-first|mixed`: default `largest-first`.
- `--model-protocol compatible|openrouter-json`: default `compatible`; explicit Pi/OpenRouter wire controls.
- `--max-output-tokens COUNT`: optional per-call generation cap, `1024`–`262144`; Pi defaults to `16384` when unset.
- `--timeout`: initial per-file attempt deadline, default `4m`.
- `--retries`: additional review attempts per file, default `3`, range `0`–`10`. Per-file timeouts add `2m` to the next attempt.
- `--run-timeout`: whole-run deadline including capture, indexing, and review, default `10m`. Isolated/precomputed context preparation has an additional five-minute ceiling within that budget; native model warmup has its own bounded allowance above.
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
- `reviews/warmup.json`: the bounded model-mediated startup readiness/indexing report, printed before file reviews.
- `reviews/native-tools.json`: native catalog/server observations and observed calls, without arguments, results, reasoning or credentials. A successful call means the harness reported completion without a tool error, not semantic correctness. Isolated Actions use `reviews/analysis-tools.json` for their separate bounded MCP bridge.
- `status.json`: local completion, failure, cancellation, or deadline classification and exit code.

Model review documents remain unchanged. Operational file records additionally distinguish `not-started` after a shared harness failure; run summaries can carry the first bounded, redacted diagnostic in `harnessFailure`. Synthetic working-copy commit IDs and the index digest identify captured states, not user commits. Bundle/evidence selection is deterministic; existing operational durations and telemetry still vary between runs.

Interactive stderr uses one updating, width-bounded dot strip in manifest order, with completed/total and running counts. Green means a validated clean file; red means findings; gray means intentionally inert/excluded; yellow `!` means a failed or omitted review. Waiting/running files use outlined dots. Failures never appear as inert or clean. Without colors, distinct symbols (`+`, `x`, `-`, `!`, `o`, `.`) retain these meanings. Retry rounds update that same live line without printing individual retry messages. Preflight messages erase the transient line instead of leaving a frozen progress bar behind. Capture and context preparation use ordinary status lines. Retry totals appear only in the final report, and there is no second final dot strip. Redirected output has no animation or automatic ANSI colors and does not emit per-file start, completion, or retry lines.

Final output uses plain headings and aligned counts, without frames or boxes. Coverage, execution and retry totals, context, incomplete reviews, findings, and capture limitations are grouped into separate sections. It states complete/incomplete review coverage, indexed-context status/provider/usable span counts, verdict, grouped failure counts, and the artifact path. Recognized harness errors use a readable explanation, including output-token exhaustion; diagnostics follow the redaction and suppression rules below before they reach artifacts. File-only fallbacks are reported before model review; they are not labeled as indexed coverage. Findings are grouped by filename, with severity, classification, side, line span, model confidence, uncertainty, explanation, and an excerpt from the authoritative captured diff. Titles and explanations wrap separately from source excerpts. Model confidence is reported as supplied, not as proof of correctness. Old/new line numbers are preserved and `>` marks cited changed lines. Each excerpt is capped at 20 lines and clearly marked when clipped or unavailable. The reader revalidates the bundle revisions, file identity, evidence, and span endpoints; it never substitutes model text for missing diff context. Existing proposed fixes are shown separately, capped at 20 lines, and labeled as not applied or test-verified. A missing fix is reported explicitly, not invented.

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

SIGINT and SIGTERM cancel capture, active indexers, and active harness processes. Unix uses process-group termination; Windows uses the OS process-tree termination tool for the spawned process IDs. No shell is used to launch a harness. Installed harness entry points are invoked directly; Redline preserves native POSIX launchers and does not interpret Windows command scripts. On Windows, a trusted npm JavaScript entry point can be launched through Node without a shell. Temporary Git/harness scratch cleanup is attempted on handled exit paths. If revision-snapshot disposal fails, the CLI prints a content-free warning without replacing the completed review result or the original execution/cancellation error; cleanup is not claimed to have succeeded. Interrupted runs can retain partial artifacts and `status.json`; they are never presented as complete reviews. Force-killing the Redline process cannot guarantee cleanup.

## Harness errors

Native OpenCode stderr and runtime error messages can contain expanded configuration, including inline credentials for unrelated providers. Redline replaces that text with a fixed suppression diagnostic before streaming or writing review artifacts. Structured failure classification still controls shared failures and retries. This does not control logs written independently by the native harness or its configured plugins.

Pi runtime errors are retained as `pi-error/v1` diagnostics, capped at 500 characters. The selected credential is redacted before control filtering, truncation, and JSON escaping. Matching covers the literal and JSON-escaped credential plus URI-component, strict RFC 3986 and form encodings through two layers, including mixed percent-escape hex case. Matching preserves unrelated diagnostic text and never recursively decodes the error message or builds a regex from the credential. This bounded set is not a guarantee for arbitrary encodings such as Base64. Only the runtime error message (or a failed process's stderr) is used, not prompt, response, reasoning, or agent-history fields. The terminal shows the first bounded diagnostic as well as failure counts. Errors discarded by older runs cannot be recovered from their artifacts.

Recognized shared authentication, credit, model/endpoint, and request-parameter failures stop new harness calls. Already-active calls settle within their existing budgets. Remaining files are recorded as omitted with `execution: not-started`, zero duration, and the shared reason; they are not counted as executed or reused. A shared fatal failure makes the run unsuccessful even if some in-flight files completed. Valid completed reviews can still be reused later.

Unknown errors, context-length errors, and content refusals remain file-local. An error stop is not retried merely because it has no text. Local execution uses the shared retry policy above. The legacy Action's one-retry cap applies only to explicit transient HTTP/transport failures or a zero-output-token empty response with a successful stop. Token exhaustion and malformed streams do not trigger Redline retries. Rejected review documents can be retried locally, but never silently repaired.

Loopback success/error tests establish request and failure handling, not live-provider acceptance. Validate a controlled one-file review against the selected live profile before another full batch; no silent protocol downgrade or larger budget is applied.

## Bounds and trust

Git capture permits at most 20,000 tree/index entries, 16 MiB per captured working file or Git command output, and 256 MiB each for aggregate captured source, working-tree content, and bundle output. Every Git command has a 30-second ceiling and also observes whole-run cancellation. Head source embeds only files up to the existing 128 KiB source-file bound; larger files are not copied into `source/`. The review prompt retains the existing 64 KiB embedded side and 512 KiB total untrusted-payload bounds.

Git commands use absolute trusted executables, argument arrays, a constructed environment, no lazy fetches, and scratch metadata without repository hooks, filters, text converters, credentials, or external diff configuration. Symlinks are captured as path/target data and are never installed into the source export. The capture and precomputed-context steps do not run project builds, tests, installers, scripts or executables. Native configured harness tools and plugins are unsandboxed in pure CLI and may do so.

This is a trusted-host CLI, not malicious-host protection. The [Docker image](./docker-workers.md) runs this same Redline CLI and its installed harnesses together. Docker is invoked externally; Redline has no container-orchestration mode. Podman and protection from an untrusted host/kernel are not implemented. The independent finding verifier remains disabled; Docker mode does not activate that quality gate.

## Release operations

Main-branch CI gates the pinned Tempel/Changesets npm flow. It creates owner-controlled version pull requests or publishes an approved version; it never approves or merges those pull requests. npm authentication still uses the owner-managed token, separately from provenance permissions.

A successful **new npm publication**, including installed-package verification, gates the [Docker image workflow](./docker-workers.md#publishing). Native amd64/arm64 jobs build and test the shared image before registry login, export the tested runtime by attested digest, and publish a matching-version GHCR manifest only after both jobs pass. Ordinary pushes and no-op releases do not publish images. There is no runtime release controller.

Keep publication credentials in owner-controlled secrets, never files, arguments or
logs. Redline does not forward its publication context to review harnesses. Native tools can use other credentials available in the user's environment or configuration; do not provide release credentials to that runtime. Local tests do not prove
registry availability or live model quality. Merge, manual publication and workflow
reruns still require explicit owner permission.
