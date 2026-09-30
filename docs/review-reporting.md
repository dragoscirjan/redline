# Review reporting

Redline keeps model output separate from forge publication. Pi and OpenCode emit versioned review events. Trusted host code validates each event against the context bundle before it stores or publishes a finding.

## Data flow

1. The host creates a private per-run journal and posts the managed running summary.
2. A backend output adapter extracts assistant text from Pi or OpenCode events.
3. `ReviewEventStreamParser` parses complete `redline-review-events/v1` JSON lines.
4. `ReviewFindingValidator` checks the schema, configured finding scope, manifest path, diff side, changed line, and exact evidence.
5. `ReviewJournal` appends and syncs the accepted finding before publication starts.
6. Inline mode publishes the finding through the forge adapter. Single-block mode waits for finalization.
7. The host renders the final summary from journal state rather than model-supplied Markdown.

The journal is an ephemeral host file with mode `0600`. It is bounded to ten findings and 512 KiB. The model container does not receive or mount it.

## Review event protocol

The model emits one finding per line:

```json
{"version":1,"type":"finding","finding":{"category":"correctness","classification":"defect","severity":"high","confidence":0.9,"fileId":"000001","path":"src/example.ts","side":"RIGHT","line":12,"evidence":"return staleValue","impact":"The endpoint returns data from the previous request.","fix":"Return the value created for the current request."}}
```

It emits one completion event last:

```json
{"version":1,"type":"completion","outcome":"findings","coverage":{"reviewedFileIds":["000001"],"omitted":[],"capabilityFailures":[]}}
```

The parser rejects malformed JSON, unknown fields, unsupported versions, oversized lines, more than ten findings, repeated completion, and events after completion. It does not repair model output. A malformed line does not discard valid sibling lines that arrived in the same output chunk. The host delivers every parsed sibling before it reports the collected protocol or validation errors.

## Backend adapters

Pi's `--mode json` output includes assistant `text_delta` events. The host extracts only those deltas and flushes pending review text at each assistant `message_end` boundary.

The pinned OpenCode CLI does not expose every text delta in its normal JSON output. The runner image therefore includes a fixed output plugin. When the host sets `REDLINE_REPORT_EVENTS=1`, the plugin tracks part types from `message.part.updated` events and forwards `message.part.delta` content only for text parts. Reasoning parts are discarded. Forwarded text uses the `REDLINE_REVIEW_TEXT_DELTA` prefix, and a text-part completion emits `REDLINE_REVIEW_TEXT_END`. The host flushes pending review text at that boundary, so a complete event does not require a trailing newline. The plugin adds no model tool and receives no GitHub credential.

The host accepts events only from the selected coordinator session. Subagent collection remains deferred.

## Host controller

`redline-review-run` connects prompt assembly, backend execution, event validation, the journal, and publication. It starts an already-created Pi or OpenCode container with a fixed `podman start` or `docker start` argument list. The command does not accept an image, arbitrary command, native backend configuration, environment map, HTTP headers, or caller-supplied prompt.

The controller starts its deadline before backend launch. It reads stdout as bounded UTF-8 lines and sends those lines to `ReviewBackendOutputConsumer` in order. It drains stderr separately and retains at most 64 KiB. Stderr never becomes a review finding or a trusted finalization message.

A valid completion event and a zero backend exit produce a complete result. Findings still return a successful controller result. Timeout, non-zero exit, launch failure, invalid output, missing completion, incomplete coverage, and publication failure produce an incomplete managed summary with a host-selected reason. The controller asks the container to stop on timeout or execution failure, then kills it when the grace period expires.

Container creation, pull, image selection, review-data staging, and native Pi or OpenCode configuration remain outside this command. A later action step must prepare the container and pass its validated ID to the controller.

## Publication modes

The trusted workflow selects one mode before backend execution.

### Single-block

The running summary is updated only at finalization. The final body contains all accepted findings stored in the journal.

### Inline

The host publishes accepted findings one at a time, up to the ten-finding run limit. Each inline comment has a stable hidden marker based on the finding ID and reviewed head revision. The final managed summary reports counts and coverage without repeating the inline comments.

A progressive set of at most ten comments is one bounded publication set for the review run.

## GitHub ownership and retries

`GitHubReviewPublisher` derives the expected actor from the supplied token through `GET /user`. It updates a managed summary only when both the actor and trailing Redline marker match. Multiple matches are an error.

Before each inline publication and finalization, the reporting service verifies the current pull request head. Stable finding markers make a later inline retry idempotent after an uncertain API result. The adapter retries safe HTTP requests after 429, 502, 503, and 504 responses at most twice. It does not retry a comment-creation request in place because GitHub may have created the comment before returning an error.

The GitHub token is a constructor dependency of the host adapter. It is not included in model configuration, prompts, journal records, rendered comments, or errors.

## Incomplete reports

Finalization accepts this host-owned value:

```ts
interface ReviewCompletion {
  status: "complete" | "incomplete";
  reason?: "backend-timeout" | "backend-failure" | "coverage-incomplete" | "publication-failure";
  message?: string;
}
```

An incomplete completion requires a reason. Its optional message is plain text limited to 500 characters. Repository content and model output cannot set this message.

The host can finalize without a model completion event when status is `incomplete`. The report includes findings already persisted and states that coverage was not finalized. A complete finalization requires a valid model completion event.

## Current limitations

- The controller starts only an already-created container. Container creation and data staging remain tracked by #20, and immutable image selection remains tracked by #23.
- The GitHub Action does not yet invoke Pi or OpenCode. Composite-action and reusable-workflow wiring remain tracked by #21 and #22.
- A timeout before the first complete finding event produces no finding. The managed summary still reports an incomplete review.
- A hard runner termination can prevent final summary publication. Inline comments published before termination remain visible.
- Cross-workflow journal recovery is not supported.
- Forgejo and Gitea publication adapters are not implemented.
- Subagent candidate persistence and promotion are not implemented.
