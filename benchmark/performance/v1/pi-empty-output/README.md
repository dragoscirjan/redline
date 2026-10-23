# Pi empty-output observation

Issue [#150](https://github.com/dragoscirjan/redline/issues/150) requires a bounded diagnosis when Pi exits successfully but produces no final assistant text.

## Controlled live observation

On 2026-10-23, Pi 1.3.0 ran through Redline's production Pi executor against the repository's local OpenAI-compatible mock endpoint. The endpoint returned an empty assistant response with a normal stop. Pi emitted its live event stream and exited with status 0.

The `pi-no-text/v1` diagnostic classified the result as `missing-text-parts` with cause `provider-output`. The retained stream was complete: 2,810 of 2,810 stdout bytes, no stderr, no malformed events, and no final content-part types. The final bounded event-type suffix was `turn_end`, `agent_end`, `other`.

This controlled run reproduces the exit-0/no-assistant-text symptom and verifies the new classification path. It does not claim that the same provider behavior caused the two earlier intermittent dogfood failures.

## Historical evidence

Workflow runs `39855691750` and `39856452560` each recorded a different omitted file with the legacy reason `pi exited with code 0 and produced no assistant text`. Both logs ended with `message_end`, `turn_end`, and `agent_end` heartbeats. This rules out a simple missing-`turn_end` explanation, but the old diagnostics did not retain content-part types, stop reason, token count, or capture state. The exact historical class therefore cannot be reconstructed safely.

## Data boundary

`observation.json` contains only status, timings, byte counts, truncation flags, bounded event/content-part types, stop reason, token count, and historical workflow identifiers. It excludes prompts, source text, raw model output, stderr text, reasoning, credentials, and tokens. No retry was added.
