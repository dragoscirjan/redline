# Internal worker protocol

This is the private transport used by the [Docker workers](./docker-workers.md) in
[#203](https://github.com/dragoscirjan/redline/issues/203). The image bootstrap bridges its
pinned SDK to the host credential broker over framed stdio.

This channel is not the public [stdio JSON-RPC protocol](./stdio-protocol.md).
It adds no public RPC method or SDK export. CLI/RPC startup selects the executor;
review requests cannot change it. Direct execution remains the default.

## Trust boundary

The trusted host builds prompts, selects the model and generation URL, retains the real
provider credential, validates findings, and owns artifacts. The worker runs one selected
harness. The container adapter must verify its immutable image identity and enforce the
runtime security profile before attaching the byte channel.

`ModelBroker` makes only POST requests to the full generation URL supplied by the trusted
adapter. Worker messages contain no URL, credential, host path, executable or Docker flags.
The broker accepts only the configured model and rejects nonempty tool/function,
plugin and agent declarations.
It never follows redirects. Configure the final generation URL. URL user information and
fragments are invalid. Bearer authentication and auth-none are supported.

The broker does not prove that a model answer is correct or that a compromised SDK obeyed the
review prompt. Authoritative finding validation remains on the host. Image verification,
disabled SDK tools, filesystem isolation and blocked external networking remain the container
adapter's responsibility. This protocol alone is not a sandbox.

## Framing and schema

Each frame is a UTF-8 JSON object preceded by `Content-Length: N\r\n\r\n`. N counts bytes.
The shared codec is `src/transport/framing.ts`; public RPC uses the same codec with its
existing limits, but a different message contract.

`src/harness-worker/contract.ts` defines the runtime schema and TypeScript unions.
Every message has `protocol: "redline-worker/v1"`. Every message except `hello` has the
host-generated UUID `jobId`. Unknown kinds/properties, noncanonical base64, wrong value types,
unsupported versions and non-finite measurements fail closed. Errors use fixed local messages,
not worker-supplied text. Receivers reject malformed UTF-8 rather than substitute characters.

Large payloads use canonical base64 chunks. Chunk boundaries are byte boundaries, not character
boundaries. Empty payloads need no data frame. Receivers reconstruct UTF-8 only after complete
payloads or through a streaming decoder.

| Bound | Limit |
| --- | --- |
| Frame header / JSON body | 1 KiB / 1 MiB |
| Decoded frame queue | 32 messages / 2 MiB |
| Data chunk | 64 KiB before base64 |
| Serialized prompt or model request | 8 MiB |
| Combined system/user prompt text | 1 MiB |
| Response-schema nesting | 64 levels |
| Model response | 64 MiB maximum, with a trusted lower budget allowed |
| Result text | Existing token-derived capture bound, 8 MiB through 64 MiB |
| Diagnostic | 256 KiB |
| Incomplete frame | 10 seconds, not extended by partial-byte keepalives |
| Blocked output write | 5 seconds |
| Response headers | 32 selected fields / 8 KiB |

The existing prompt builder still applies its tighter untrusted-context bounds. These transport
limits do not grant additional context or output-token allowances. All work also has the host's
finite invocation deadline. The adapter must clamp that deadline to the remaining run budget.
A blocked transport can take up to the write bound to settle after cancellation.

## Invocation sequence

1. The worker sends `hello` with `identity`. Its fields are `harness`, `release`, `revision`
   and `harnessVersion`. The host compares every field with its trusted expected identity.
   The hello is a compatibility check, not proof of an image digest.
2. The host sends `invoke`. Its fields are `harness`, `model` with provider/model names,
   `timeoutMs`, `retryOwnership`, `modelProtocol`, and optional `maxOutputTokens`/`streamMode`.
   There is no endpoint, credential map, work directory or tool-permission field.
3. The host sends `input` frames with `data`, then `input.end`. Together they encode the
   JSON prompt with `system`, `user` and optional fixed `responseSchema`. Host-only
   fingerprint metadata is explicitly excluded from this projection.
4. The worker requests model traffic as described below, then sends `output` frames with
   `stream: "text"` or `stream: "diagnostic"` and base64 `data`. Optional bounded `tap`
   messages report live text/diagnostic activity without replacing final output validation.
5. The worker sends one `result` with `run`. This is `HarnessRun` metadata without inline
   text/diagnostic fields. Only the existing status, exit, timing, failure/retry and telemetry
   members are valid. The host reconstructs bounded text and diagnostics separately.

The host refuses a result while a model request is incomplete or active. It rejects job-ID,
build-identity and harness mismatches, out-of-order requests and EOF before a result.
The worker must not retain conversation/configuration state for the next invocation.

If the selected credential appears in prompt data or projected invocation metadata, the host
refuses to send it. It does not silently rewrite authoritative source evidence. This protects
the credential even when it also appears in reviewed source; use a separate credential for
such a review. The input check recognizes the same literal/encoded forms as diagnostic redaction.

## Model exchange

The worker sends `request.start` with a sequential `requestId` and `accept`, then zero or more
`request.data` frames and `request.end`. Accept is `application/json`, `text/event-stream` or
`*/*`. The bounded body must be a JSON object selecting the job's configured model. When the
host has an effective output-token cap, the body must supply a positive cap no larger than it.
Each supplied token-cap field is checked; a second field or null cannot bypass the bound.
The broker preserves valid request-body bytes, reasoning/vendor fields and stream settings.

The host sends `response.start` with `status` and selected `headers`, zero or more
`response.data` frames, then `response.end`. HTTP error statuses are responses, not broker
retries. Content type, retry timing and selected request/rate-limit measurements survive.
Cookies, redirects, authentication headers, compression metadata and arbitrary headers do not.
Fetch decodes compressed bodies before transport. The broker redacts literal and encoded
credential reflections across HTTP/UTF-8 chunk boundaries before the worker receives them.

Transport failure or a byte limit produces `response.error` with code `transport` or `limit`.
This terminates that response. The image adapter must fail an interrupted SDK stream rather
than accept a partial model answer as complete.

Only one model request can be active. The trusted caller derives `maxRequests` from its pinned
executor's native retry behavior. It must not substitute the Redline outer retry count for that
allowance. The broker performs no HTTP retries. Each Redline invocation/retry gets a new worker
and lease. Host-local model URLs keep their host meaning because only the host opens upstream
connections. The worker needs no direct provider/host-network route.

## Cancellation and ownership

`cancel` is the explicit host cancellation message available to a bootstrap. Closing the byte
channel also terminates the invocation. The host broker revokes access at completion, external
abort, deadline, protocol failure, disconnect or failed output. It aborts upstream response work,
including responses whose consumers stop early. Subsequent requests fail before network effects.

`runWorkerJob` owns its input/output streams and broker lease. The container/process owner must
still reap the child/container in its own finally path, handle bootstrap failure, and reconcile
only its own crash leftovers. A dead host cannot promise immediate container deletion through
this protocol. There is no persistent host listener or ambient environment dependency in the broker.

## Evidence

Transport tests use synthetic credentials, loopback HTTP/SSE/compressed responses and a
scripted Node subprocess. The separate native container suite runs real pinned Pi and
OpenCode images through CLI and RPC, including retries, fatal reflected-auth errors,
cancellation and the kernel/network/filesystem/cgroup profile. Both native architectures
are required release gates. Builds or skipped tests do not count as runtime evidence.

Neither suite proves Docker Desktop support, live model quality or a successful production
publication. Public release acceptance requires the separate anonymous installed-package
and image verification described in [coordinated releases](./coordinated-releases.md).
