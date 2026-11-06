# Root-cause tracing

Use when the error appears far from its trigger or when data crosses several components.

## Trace backward

1. Identify the first observed violation: the wrong value, missing state, invalid path, or broken invariant.
2. Inspect the operation that consumed it. Record the expected contract and the actual input.
3. Find the caller or producer that supplied that input. Continue backward until locating where valid state first became invalid, or where an invalid input first entered the system.
4. Check the original input, default, conversion, configuration source, or lifecycle event at that boundary.
5. Write the causal chain and test its earliest unsupported link.

For example, a command runs in the wrong directory because a caller supplies an empty path, not because the command itself needs another retry. Verify whether the path was missing, overwritten, normalized incorrectly, or read before initialization.

## Instrument boundaries selectively

For a pipeline, service call, subprocess, or build step, compare:

- sanitized input shape and relevant output
- actual configuration source and whether a required value exists
- ownership and lifecycle of shared state
- operation identifiers and ordering, without private payloads

Log presence or an allowlisted property when the value itself is sensitive. Do not print entire environments or credentials. Load project instrumentation conventions before adding diagnostics.

Distinguish source evidence from runtime evidence. A suspicious caller is not the cause until a reproduction or focused experiment connects it to the failure.

## Fix the responsible boundary

Prefer correcting the producer or enforcing the contract where invalid input enters. Add an independent downstream guard only when another caller, trust boundary, or unsafe effect can bypass that protection.

Test both the original failure and any supported alternate path that motivated an additional guard. Return to the main workflow for implementation and validation; tracing alone does not authorize edits.
