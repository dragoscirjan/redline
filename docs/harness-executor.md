# Harness executor

The harness executor layer (`src/harness-executor/`) adapts the generic review-execution contract to one coding-agent harness. The review core never learns harness specifics; it sees one interface.

## Interface

```ts
interface HarnessExecutor {
  readonly harness: HarnessName;        // 'echo' | 'pi' | 'opencode'
  prepare(settings: HarnessSettings): Promise<PreparedHarness>;
  execute(prepared: PreparedHarness, prompt: HarnessPrompt): Promise<HarnessRun>;
}
```

- `prepare` runs once per review: it generates the harness configuration
  (model endpoint, credential, review agent) inside a caller-managed work
  directory.
- `execute` runs once per file: one non-interactive prompt with a fixed
  system policy and the file's untrusted context, under a timeout and
  bounded output limits.
- `HarnessRun` reports `succeeded`, `failed`, or `timed-out`, the extracted
  assistant text, and a bounded diagnostic. Credentials never appear in
  diagnostics or configuration descriptions.

The registry (`createHarnessExecutor`) is the factory: resolving a harness
name to its implementation is the only harness-specific decision the review
core makes.

## Harness implementations

### Pi

- Generated `models.json` in an isolated agent directory, selected with
  `PI_CODING_AGENT_DIR`. The host user's own Pi configuration never loads.
- The provider credential travels through the `REDLINE_MODEL_API_KEY`
  environment variable; `models.json` only references it by interpolation,
  so the value never appears in a generated file.
- Invocation: `pi --print --mode json --no-session --no-tools --provider …
  --model … --system-prompt … -- <user prompt>`.
- Assistant text is extracted from the final `turn_end` event of Pi's
  newline-delimited JSON stream.

### OpenCode

- Generated `opencode.json` (mode 0600) selected with `OPENCODE_CONFIG`, plus
  redirected `HOME` and `XDG_*` directories so the host user's
  configuration, plugins, and MCP servers never load. The process runs with
  `--pure`.
- The config registers a `redline-review` agent with the fixed review
  policy as its system prompt and every built-in tool disabled, including
  the `skill` tool.
- OpenCode has no environment-interpolation mechanism comparable to Pi's
  `models.json`, so the selected credential is written into the generated
  config file — mode 0600 inside the review's temporary work directory,
  which is deleted when the run ends.
- Invocation: `opencode run --pure --format json --agent redline-review
  --model provider/model -- <user prompt>`.
- Assistant text is concatenated from `text` parts of the JSON event stream.

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

Security rules for every implementation: argument arrays only (no shell),
tools disabled, isolated generated configuration, constructed environment
without ambient credentials, bounded output, and timeouts.
