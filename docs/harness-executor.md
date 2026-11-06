# Harness executor

The harness executor layer (`src/harness-executor/`) adapts the generic review-execution contract to one coding-agent harness. The review core never learns harness specifics; it sees one interface.

## Native CLI and Docker

Current source uses the installed `pi` or `opencode` entry point directly for local CLI and Docker reviews. This behavior is not in published 1.2.2. Redline does not manually launch the harness's JavaScript entry point through its own Node runtime.

Both harnesses keep their normal global and checkout-local configuration, MCP servers, plugins, tools and permissions. Additional configured MCPs remain available. Pure CLI prints a prominent unsandboxed-execution warning. Docker is the container execution boundary; host configuration is visible only when explicitly supplied. Further container hardening is separate work.

Precomputed CGC context is independent of native MCP configuration. A failed base-index build does not disable the harness's configured CGC server. Conversely, an installed or connected server does not prove an indexed repository, a successful query or correct findings.

`reviews/native-tools.json` and per-file records distinguish observed tool names, native server states where the harness exposes them, calls started, successful calls and failures. Pi supplies a runtime tool catalog. OpenCode supplies observed native calls. Both use a bounded model-mediated warmup report before file work, not a separate manual MCP-list command. Missing or unobserved requested integrations warn without filtering the remaining configured servers. Tool arguments, results and reasoning are not retained in these diagnostics.

The current GitHub Action keeps its isolated execution described below. Moving it to the image is a separate milestone.

## Interface

```ts
interface HarnessExecutor {
  readonly harness: HarnessName;        // 'echo' | 'pi' | 'opencode'
  prepare(settings: HarnessSettings): Promise<PreparedHarness>;
  execute(prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun>;
}
```

- `prepare` runs once per review: it validates and retains the bounded model,
  credential, command, and configuration template inside a caller-managed
  work directory.
- `execute` runs once per file-review attempt: it creates private request/prompt overrides,
  and, in isolated execution only, separate configuration, home and state directories.
  It sends one non-interactive prompt with a fixed
  system policy and the file's untrusted context, under a timeout and
  bounded output limits. The optional `options.timeoutMs` is a positive safe
  integer in milliseconds; it overrides the prepared `HarnessSettings.timeoutMs`
  for that invocation. When absent, the prepared timeout applies. Invalid
  overrides fail before spawning; expiry kills the child.
- `HarnessRun` reports `succeeded`, `failed`, or `timed-out`, the extracted
  assistant text, and a bounded diagnostic. Credentials never appear in
  diagnostics or configuration descriptions.

The registry (`createHarnessExecutor`) is the factory: resolving a harness
name to its implementation is the only harness-specific decision the review
core makes.

## Harness implementations

### Pi

Native CLI/Docker keeps `HOME`, `PI_CODING_AGENT_DIR`, global settings and checkout-local resources. It runs `pi --print --mode json --no-session --approve --provider … --model …`, appends Redline's policy with `--append-system-prompt`, and adds a private standard extension for the selected endpoint, generation cap, optional OpenRouter schema and metadata-only tool observations. It does not replace MCP configuration or filter tools. The selected model must exist in Pi's native catalog or configuration. Existing model metadata and reasoning are preserved, and Redline does not persist model-setting changes.

The following configuration rules apply to isolated Actions:

- Every invocation gets a separate mode-0600 `models.json` and system-prompt file in an isolated agent directory selected with `PI_CODING_AGENT_DIR`. Concurrent calls never share generated files. The host user's own Pi configuration never loads.
- The provider credential travels through the `REDLINE_MODEL_API_KEY`
  environment variable; `models.json` only references it by interpolation,
  so the value never appears in a generated file.
- Invocation starts with `pi --print --mode json --no-session --provider …
  --model … --system-prompt <generated-policy-file>`. Verified MCP availability
  adds only exact `mcp__redline_*` tool names and the built-in MCP integration.
  With no available tools, Redline supplies `--no-tools`. Pi reads the fixed
  policy from a mode-0600 file in the temporary agent directory and the
  bounded user prompt from stdin. Large untrusted review context never
  enters a process argument.
- Assistant text is extracted from the final `turn_end` event of Pi's
  newline-delimited JSON stream.
- Production Pi preserves model/provider reasoning defaults and never forces
  thinking off. The default output cap remains 16,384 tokens, with explicit
  caller overrides preserved. Provider sampling is unchanged. Controlled benchmarks
  can set temperature `0`, but cannot disable reasoning. Pi's own agent and provider retries are disabled.
- Legacy Action execution permits one adapter-managed retry only for classified transient provider output:
  empty or missing text in the final successful turn, or a bounded 429/500/502/503/504,
  rate-limit, reset, or transport diagnostic. The retry uses a fresh isolated
  invocation directory and the same total per-file deadline. Timeouts,
  output-budget exhaustion, malformed streams, capture truncation, parser
  failures, and validation failures are never retried.
- The review runner supplies `retryOwnership: caller` when it owns `--retries`, disabling adapter retries. Native CLI additionally retains the user's own Pi retry configuration. Native provider retries, outer review attempts and tool activity remain bounded by the file and whole-run deadlines.
- When Pi exits without usable final assistant text after that policy, the
  file is omitted. Its reason is a bounded `pi-no-text/v1` JSON diagnostic
  that classifies capture truncation, malformed events, a missing `turn_end`,
  missing or empty text parts, or model output-budget exhaustion. The payload
  contains only exit status, timings, byte counts, truncation flags, bounded
  event/content-part types, stop reason, and output-token count. Its `stdout`
  and `stderr` tuples are `[total bytes, retained bytes, truncated]`; prompt,
  source, raw output, stderr text, reasoning, and credentials are excluded.
  Truncated output is accepted only when a retained `agent_settled` event
  confirms that the selected `turn_end` is final. `HarnessRun.telemetry`
  can carry numeric token and cost metadata plus retry count; it never carries
  prompts, source, raw output, reasoning, credentials, or publication tokens.

### OpenCode

Native CLI/Docker runs `opencode run --dir <checkout> --format json --agent redline-review --model provider/model` without `--pure` or redirected home/XDG paths. A final `OPENCODE_CONFIG_CONTENT` merge adds only the selected provider request settings and review-agent prompt, preserving global/local MCPs, plugins, permissions and existing inline configuration. The credential is referenced as `{env:REDLINE_MODEL_API_KEY}`. Redline does not add `--auto` or override the user's permission decisions. The native model-mediated warmup discovers tools and prepares/queries captured-source indexes; Redline does not run a separate MCP listing probe.

The following configuration rules apply to isolated Actions:

- Every invocation gets a separate generated `opencode.json` (mode 0600) selected with `OPENCODE_CONFIG`, plus separate redirected `HOME` and `XDG_*` directories. Concurrent calls never share mutable configuration or state, the host user's configuration, plugins, and MCP servers never load, and the process runs with `--pure`.
- The config registers a `redline-review` agent with the fixed review
  policy as its system prompt and every built-in tool disabled, including
  the `skill` tool.
- This isolated adapter writes the selected credential into its generated mode-0600 configuration in the temporary work directory. Native execution instead uses OpenCode's environment interpolation and does not write the key into configuration.
- Invocation: `opencode run --pure --format json --agent redline-review
  --model provider/model`, with the bounded user prompt on stdin. The
  generated configuration still supplies the fixed system policy.
- Assistant text is concatenated from `text` parts of the JSON event stream. In caller-managed execution, a runtime `error` event rejects partial text, and only its status/message/retryability metadata is classified and credential-redacted. Response bodies and reasoning are not copied into failure diagnostics.
- Local CLI `--retries` counts complete Redline attempts, not provider requests. OpenCode 1.18.34 hardcodes five native provider retries. There is no supported switch here to disable them; do not invent one. Thus four Redline attempts can issue up to 24 provider requests. Those native retries share the current attempt's timeout, and all attempts share the hard run deadline. Isolated Pi instead issues one provider request per caller-managed attempt. Native Pi follows its user retry settings. Loopback tests verify the isolated counts.

### Echo

A deterministic in-process harness used by tests and the CI harness matrix.
It answers every prompt with a `clean` review document for the file the
prompt targets, extracted from the prompt's machine-readable manifest block.
It never spawns a process and never needs a model endpoint.

### The CI harness matrix

The CI workflow runs every harness end to end against the local mock model
endpoint and publishes each harness's review output as a
`harness-<harness>-reviews-…` artifact. Pi and OpenCode are served a scripted
finding document, so the artifacts carry real diff-validated findings
(stable id, side, line, byte-identical evidence) through the whole pipeline,
while echo demonstrates the deterministic clean path. No secrets or live
models are involved.

## Optional read-only analysis

This section applies to isolated Actions, not native CLI/Docker. The isolated Pi and OpenCode adapters probe optional integrations before file prompts. The probe has a
20-second limit inside the existing run deadline. Missing packages, incompatible
versions, failed startup, missing context-mode integrations and empty CGC graphs
are reported in `reviews/analysis-tools.json`. The CLI warns and continues without
those tools. An optional integration does not become a requirement for a prompt.

The isolated integration targets Pi 1.4.0 and OpenCode 1.18.34, with CGC 0.5.7,
GitNexus 1.6.12 and context-mode 1.0.169. Sequential-thinking is checked through
its standard API, including compatible date-versioned installations. Unsupported
integrations are reported rather than silently installed or replaced.

The fixed allowlist is:

| Component | Model-facing tools |
| --- | --- |
| CGC | `find_code`, `analyze_code_relationships`, `get_repository_stats` |
| GitNexus | `query`, `context`, `impact` |
| context-mode | `ctx_index`, `ctx_search` |
| sequential-thinking | `sequentialthinking` |

The isolated harness integration connects through a standard MCP boundary that
checks every call. It rejects execution, administrative operations, network
retrieval, repository selectors and writes. Context-mode indexes only approved
relative files from captured head source. Searches stay in that run's private
index. Graph queries use a separate bounded captured-source graph, not an ambient
user database. The approved source subset is limited to 200 files and 2 MiB,
with a 128 KiB per-file limit. Graph preparation uses at most 100 code files.
Each component permits at most 32 calls per file invocation. Tool failures remain
coverage limitations, never proof that callers or tests do not exist.

All built-in tools remain disabled. MCP children receive constructed environments
without model keys, GitHub tokens or ambient configuration. The isolated v10 policy declares
only verified available tool names. Tool results remain untrusted, and findings
still need authoritative diff mapping and byte-identical evidence. Available tool
versions and captured analysis bytes participate in review-result reuse identity.

The context-mode adapter module is checked for availability and import
compatibility. Its stock hooks are not activated, because they can inject
repository instructions and expose execution or administrative tools. The
`loadable-not-activated` status means the module is installed and loadable, not
that its hooks run. Context-mode index/search use native MCP in both harnesses.

CGC uses preinstalled tree-sitter-language-pack 1.22.1 grammars. Docker builds stage
12 grammars from a checksum-pinned manifest and verified platform bundles. Runtime
loading uses a trusted library directory and a fresh private cache with a local,
nonexistent download manifest. Missing grammars fail locally without reaching a
remote download service. Local runs can use a preinstalled standard grammar cache
or a trusted `TREE_SITTER_LANGUAGE_PACK_LIBS_DIR` outside the reviewed repository.

## Adding a harness

1. Implement the `HarnessExecutor` interface in a new module under
   `src/harness-executor/`.
2. Register the name in `HARNESS_NAMES` and the factory in
   `src/harness-executor/registry.ts`.
3. Extend the environment contract documentation and the action input
   description with the new name.
4. Add unit tests for configuration generation and event parsing, plus an
   opt-in live test against `test/fixtures/mock-model-server.mjs`.
5. Add the harness to the CI matrix in `.github/workflows/ci.yml`.

The shared process runner caps stdin at 1 MiB and retains its output and
execution-time limits. The argument list contains only trusted options and
paths. This prevents `spawn E2BIG` when a reviewed file's captured diff and
source exceed the operating system's per-argument limit.

All implementations use argument arrays without a shell, bounded output and timeouts. Native execution keeps the harness's configured tools, plugins and user-owned MCP credentials. Isolated Actions disable built-in tools and restrict MCP calls, generated configuration and credentials. Redline's publication token is never handed to either profile.
