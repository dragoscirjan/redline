# Harness executor

The harness executor layer (`src/harness-executor/`) adapts the generic review-execution contract to one coding-agent harness. The review core never learns harness specifics; it sees one interface.

The local CLI and RPC can select the opt-in [Docker executor](./docker-workers.md).
It wraps the existing Pi/OpenCode process launches, without a custom worker protocol or
model broker. The current GitHub Action is not rewired by this milestone.

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
- `execute` runs once per file-review attempt: it creates an invocation-specific configuration,
  prompt, home, and state directory, then sends one non-interactive prompt with a fixed
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

## Docker adapter

The Docker executor wraps Pi/OpenCode with fresh hardened containers for every attempt.
The host retains review control, validation and artifacts. The SDK receives only its
selected provider credential and generated configuration through a read-only input mount.
Bridge networking permits the provider connection; no repository mount, Docker socket,
GitHub token or unrelated host credential is available. Requested
Docker execution fails closed without direct fallback. Image digests enter the semantic
reuse identity. See the worker guide for build commands, limits and supported hosts.

## Harness implementations

The Pi/OpenCode configuration details below apply to both modes. Docker uses the same
host-side adapters and output parsers with a Docker-backed process spawner. Echo remains
in-process and has no Docker image.

### Pi

- Every invocation gets a separate mode-0600 `models.json` and system-prompt file in an isolated agent directory selected with `PI_CODING_AGENT_DIR`. Concurrent calls never share generated files. The host user's own Pi configuration never loads.
- The provider credential travels through the `REDLINE_MODEL_API_KEY`
  environment variable; `models.json` only references it by interpolation,
  so the value never appears in a generated file.
- Invocation: `pi --print --mode json --no-session --no-tools --provider …
  --model … --system-prompt <generated-policy-file>`. Pi reads the fixed
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
- Local CLI execution supplies `retryOwnership: caller`, disables this adapter retry and lets the review runner own `--retries`. Invalid review documents, per-file timeouts and bounded excerpt retries are handled there. Agent and provider retries remain disabled; reasoning and output-token limits remain unchanged.
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

- Every invocation gets a separate generated `opencode.json` (mode 0600) selected with `OPENCODE_CONFIG`, plus separate redirected `HOME` and `XDG_*` directories. Concurrent calls never share mutable configuration or state, the host user's configuration, plugins, and MCP servers never load, and the process runs with `--pure`.
- The config registers a `redline-review` agent with the fixed review
  policy as its system prompt and every built-in tool disabled, including
  the `skill` tool.
- OpenCode has no environment-interpolation mechanism comparable to Pi's
  `models.json`, so the selected credential is written into the generated
  config file — mode 0600 inside the review's temporary work directory,
  which is deleted when the run ends.
- Invocation: `opencode run --pure --format json --agent redline-review
  --model provider/model`, with the bounded user prompt on stdin. The
  generated configuration still supplies the fixed system policy.
- Assistant text is concatenated from `text` parts of the JSON event stream. In caller-managed execution, a runtime `error` event rejects partial text, and only its status/message/retryability metadata is classified and credential-redacted. Response bodies and reasoning are not copied into failure diagnostics.
- Local CLI `--retries` counts complete Redline attempts, not provider requests. OpenCode 1.18.34 hardcodes five native provider retries. There is no supported switch here to disable them; do not invent one. Thus four Redline attempts can issue up to 24 provider requests. Those native retries share the current attempt's timeout, and all attempts share the hard run deadline. Pi instead issues one provider request per caller-managed attempt. Loopback tests verify both counts.

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

Security rules for every implementation: argument arrays only (no shell),
tools disabled, isolated generated configuration, constructed environment
without ambient credentials, bounded output, and timeouts.
