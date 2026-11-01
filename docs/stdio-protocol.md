# Stdio JSON-RPC protocol

Use `redline rpc` when a program needs to start, query or cancel a local Git review. It is a transport over the same execution path as `redline review`. It does not implement LSP, HTTP, an editor extension, a public TypeScript SDK or forge publication.

## Visual overview

[![A client program sends stdio requests to the RPC adapter. The RPC adapter and terminal CLI share capture, review, validation and artifact writing.](/diagrams/local-review.svg)](./diagrams/local-review.html){target="_self"}

[Explore the shared review architecture](./diagrams/local-review.html){target="_self"}. Open the interactive view to zoom, select components and inspect source references. Editor extensions remain planned; the reference client is implemented.

[![An accepted run starts as running and ends as completed, incomplete, failed, cancelled or timed-out.](/diagrams/rpc-lifecycle.svg)](./diagrams/rpc-lifecycle.html){target="_self"}

[Explore the RPC run lifecycle](./diagrams/rpc-lifecycle.html){target="_self"}. A completed run can contain findings. Only a whole-run deadline produces `timed-out`; a file timeout can leave incomplete coverage. Cancellation remains cooperative, and completion can win the race.

These local diagrams use [Archify](https://tt-a1i.github.io/archify/). Their [sources and regeneration instructions](/diagrams/README) pin the generator and the reviewed code revision. The written contract below remains the reference.

## Start the process

Use Node.js 24 and the installed Redline command. The installed version must include `redline rpc`; version 1.0.0 predates this command. For an updated source checkout, replace `redline` with `node /path/to/redline/bin/redline.mjs`.

```sh
redline rpc --help
redline rpc --harness echo --indexing disabled
redline rpc --once --harness echo --indexing disabled
```

The last two commands wait for framed requests on stdin. They do not start a review by themselves. `echo` tests integration without a model or credentials. It always returns a clean answer and does not establish code quality.

For a real model, configure the existing [private user configuration](/get-started/configuration). Selecting Pi or OpenCode can send captured source to the configured provider and incur model charges. Trusted startup flags can select the harness, model, endpoint, budgets, indexing and reuse. The server reads that fixed configuration path and inherited settings for each review. Repository selection still rechecks that the configuration file and executables are outside the reviewed repository. Existing output defaults also apply. Omit a fixed output directory from persistent-session configuration because every review needs a new directory.

The startup `--auth` option accepts only `none`, the non-secret credential-less endpoint mode. It does not accept a key or token. Credentials come from the trusted configuration file or `REDLINE_MODEL_AUTH`; the RPC server passes startup options to its in-memory configuration parser. It does not forward `--auth` to a harness command line.

No credential values, configuration paths, executable paths, model endpoints, output paths or reporter selection are accepted in protocol requests. Keep credentials out of command-line values too. Reviewed content never selects configuration or executes code.

Stdout contains protocol frames only. Stderr is reserved for startup diagnostics and runtime warnings. Clients must drain both streams.

## Frame messages

Each JSON-RPC 2.0 object is UTF-8 JSON preceded by exactly one ASCII header:

```text
Content-Length: <UTF-8 byte count>\r\n
\r\n
<JSON body>
```

Here `\r\n` means the two actual CR/LF bytes, not literal backslashes. Do not append an extra newline after the body. Headers are case-insensitive but must use the shown single-space format. Additional headers, duplicate lengths, leading-zero lengths, non-ASCII headers, zero-length bodies and oversized frames are rejected.

This uses a common stdio framing convention, not LSP method semantics. JSON-RPC's `jsonrpc: "2.0"` field is distinct from Redline's protocol version `"1.0"`.

Request IDs are strings of at most 128 Unicode characters or safe integers. ID zero is valid. Null IDs are not accepted. Methods below require IDs. The only defined client notification is `redline/v1/exit`; other client notifications are ignored without a response.

Batches contain 1 to 16 messages, processed in array order. Notification-only batches have no response. Duplicate request IDs in a batch are rejected before any batch method runs. If a batch's combined response would exceed the message limit, the server replaces its largest result replies with limit errors until the batch fits. Small acknowledgements for already-accepted start, cancel and shutdown operations remain intact. Query a rejected result individually instead of repeating the operation.

## Initialize and negotiate

Send this before starting reviews:

```json
{"jsonrpc":"2.0","id":1,"method":"redline/v1/initialize","params":{"protocolVersion":"1.0","optionalCapabilities":["progress"]}}
```

The result contains the selected protocol version, capabilities and actual limits. The current server supports version `1.0`. A higher minor request within major 1 selects `1.0`; an unsupported major returns a version error. Initialize only once per process.

`git`, `cancel`, `artifacts`, `pagination` and `batch` are supported. `progress` is optional and enabled when the optional-capability list is absent or contains it. Unknown IDs in that optional list are ignored. Unknown parameter fields are rejected.

Additive compatible changes use a protocol minor version. Breaking fields or semantics require a new major namespace. Clients must use the selected version's schema rather than assuming future fields exist.

## Start a review

```json
{"jsonrpc":"2.0","id":2,"method":"redline/v1/review.start","params":{"repository":"/absolute/path/to/project","base":"main","head":"HEAD","comparison":"merge-base"}}
```

For a working-tree review:

```json
{"jsonrpc":"2.0","id":3,"method":"redline/v1/review.start","params":{"repository":"/absolute/path/to/project","worktree":"staged"}}
```

The repository must be an absolute path on the server's host. `base` defaults to `HEAD`. A supplied `head` selects committed review, with `comparison` defaulting to `merge-base`; `direct` is also supported. Without `head`, `worktree` defaults to `all` and accepts `staged` or `unstaged`. `untracked` defaults to `exclude`; `include` requires a compatible working-tree mode. Repository/target semantics and source limits remain those of the [CLI](/local-cli).

The server returns a generated `runId` and a running descriptor immediately. Configuration, revision or execution failures can then finish that accepted run with a structured error. Protocol-invalid requests never reach the review engine.

Only one review runs per process. Additional starts receive a busy error, not an implicit queue. Existing per-file concurrency, retries, deadlines, reasoning behavior and private result reuse are unchanged.

## Query and cancel

Use the returned `runId` in these calls. Replace the example UUID with that actual value.

```json
{"jsonrpc":"2.0","id":4,"method":"redline/v1/review.get","params":{"runId":"00000000-0000-0000-0000-000000000000"}}
```

```json
{"jsonrpc":"2.0","id":5,"method":"redline/v1/review.cancel","params":{"runId":"00000000-0000-0000-0000-000000000000"}}
```

Descriptors contain state, exit code, a bounded error or null, artifact references when available, result availability and progress counts. States are `running`, `completed`, `incomplete`, `failed`, `cancelled` and `timed-out`. Completion can still contain findings; coverage and exit code remain separate.

Cancellation aborts pending work through the existing process/worker controls. The acknowledgement can still show `running` while children stop and artifacts settle. Wait for terminal state. If completion wins the race, it remains completed. Cancelling a terminal run does not change it. Exactly one finished notification is produced for an accepted run while output remains writable.

## Consume notifications and results

- `redline/v1/artifacts` supplies a run descriptor as soon as the private output directory exists. Retain its references for crash recovery.
- `redline/v1/progress` supplies `runId`, a monotonic sequence and metadata-only events. Updates are coalesced at 100 ms intervals, with a final flush before terminal state, and may be dropped under backpressure. Counts track required, settled and active files. Settled files can include omissions and are not proof of successful coverage. Retries can move files back to active.
- `redline/v1/finished` supplies the terminal descriptor.

Progress never includes source paths, source payloads, prompts, raw model text, reasoning or credentials. Validated result pages can contain source evidence, suggestions and deterministic fix prompts. Redline redacts selected credentials without changing other evidence whitespace.

After terminal state, request a page:

```json
{"jsonrpc":"2.0","id":6,"method":"redline/v1/review.result","params":{"runId":"00000000-0000-0000-0000-000000000000","section":"findings","offset":0,"limit":20}}
```

Sections are `overview`, `files` and `findings`, with `overview` as the default. Responses contain `total`, `items` and `nextOffset`. A null next offset means the section is exhausted. Smaller pages can be returned to fit the byte limit.

The overview includes verdict, required/completed/omitted/excluded coverage, context status, finding count and limitations. File entries include outcome and structured diagnostics. Findings include authoritative locations and evidence, classification, severity, confidence, supporting evidence, root cause, impact, verification/remediation status, guidance, suggestion and fix prompt. Diff/structure validation is not proof that the model's diagnosis or proposed fix is correct. These are validated review projections, not raw model records. Paths and finding text are still untrusted display data. Render them as text, and never execute suggestions automatically.

A run that exceeds result-retention limits can complete with `resultAvailable: false`. Querying that result, or a single item too large for one frame, returns a limit error. Use the written artifact references instead. No finding is silently removed to pretend coverage is complete.

## Limits and backpressure

| Resource | Limit |
| --- | --- |
| Header including delimiter | 1,024 bytes |
| JSON body, inbound and outbound | 1 MiB |
| Buffered frame queue | 32 messages and 2 MiB |
| Batch | 16 messages |
| Terminal history | 8 runs per process |
| Total retained result data | 8 MiB, at most 4 MiB per run |
| Result page | 1 to 50 items, default 20 |
| Partial-frame deadline | 10 seconds |
| Stalled output write | 5 seconds |

Completed runs are evicted oldest-first as history or byte bounds require. Evicted IDs return a not-found error. Limits do not enlarge model/source budgets. A peer that stops reading causes cancellation and connection failure rather than unbounded buffering. Protocol writes use asynchronous fixed-descriptor streams so Windows pipe writes cannot block cancellation timers. If an OS write cannot be released, the dedicated server forcibly terminates itself only after review cleanup and terminal artifact writes settle. Optional progress leaves queue capacity for responses and terminal events. An overflowing mandatory queue fails closed.

## Shutdown, EOF and crash recovery

```json
{"jsonrpc":"2.0","id":7,"method":"redline/v1/shutdown","params":{}}
```

Shutdown stops new requests, cancels any active review and drains settled output. The `redline/v1/exit` notification has the same cancellation intent but no response.

In persistent mode, stdin EOF means the client disconnected and cancels active work. With `--once`, only one review is accepted, and EOF drains that already-accepted review within its configured run deadline. One-shot clients can instead keep stdin open, query result pages, then shut down. Both modes use the same methods and conformance suite.

On platforms that deliver them to Node, SIGINT/SIGTERM cancel pending work. Use the RPC cancellation method for portable cancellation. Process exit codes are 0 for a clean session shutdown, 1 for transport/session failure, 2 for invalid startup arguments and 130 for an interrupt. Irrecoverable output failure can instead end the process by signal. Treat any nonzero exit or signal as a session failure; do not infer completion from it. A review's own exit code is in its descriptor; it does not kill a persistent session.

After an abrupt crash, do not infer success from a lost connection or partial files. Retain artifact references, inspect `status.json`, and treat missing/nonterminal status as unfinished. Run IDs are process-local and are not rehydrated after restart. A new review can reuse eligible validated file results through the existing private cache. Failed/incomplete work is never promoted to success.

## Error codes

| Code | Meaning |
| --- | --- |
| -32700 | Framed JSON parse error |
| -32600 | Invalid envelope, batch or fatal frame |
| -32601 | Method not found |
| -32602 | Invalid parameters |
| -32603 | Internal or protocol-reporting failure |
| -32000 | Initialization/session state error |
| -32001 | Unsupported protocol major |
| -32002 | Active run, unfinished result or consumed one-shot slot |
| -32003 | Unknown or evicted run |
| -32004 | Message/result resource limit |
| -32100 | Trusted configuration error |
| -32101 | Revision/capture/context preparation error |
| -32102 | Model execution error |
| -32103 | Review deadline/timeout |
| -32104 | Cancellation |
| -32105 | Review validation incomplete |
| -32106 | Unavailable capability |

Envelope/parameter errors are request errors. Accepted review failures are terminal run descriptors. A framed JSON parse error can be followed by another frame; an ambiguous, oversized or truncated frame closes the connection. Diagnostics do not echo request/configuration values.

## Schemas and conformance

The installed package includes `schemas/rpc/v1/protocol.schema.json`. The server interprets its committed definitions at runtime before dispatch. Named method-parameter, descriptor, result, error and notification definitions make the application contract explicit.

The internal reference client is `test/helpers/rpc-client.ts`; reusable malformed-request cases are in `test/fixtures/rpc/conformance.json`. They test one-shot and persistent processes against the same contract, including the offline-installed npm artifact. The native CI matrix runs protocol tests on Linux, macOS and Windows, each x64 and ARM64. No live model is needed.

References: [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification) and [stdio header convention](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#headerPart). This protocol does not claim LSP compatibility.
