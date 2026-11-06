# Asynchronous failures

Use for flaky tests, races, intermittent timeouts, and failures that depend on execution order or machine load.

## Find the missing event or ordering guarantee

1. Identify the required observable condition: an event received, state committed, resource ready, or operation completed.
2. Record when the producer starts, when the condition becomes true, and when the consumer checks it.
3. Check whether registration happens before the event, whether observations are fresh, and whether cancellation or teardown races with completion.
4. Reproduce with the project's supported scheduler, fake clock, or controlled ordering where possible.

A longer timeout may hide a race. First establish why the required condition was absent or observed too early.

## Wait for the condition

Prefer a framework-native assertion, event subscription, or completion primitive. If polling is necessary:

- use a bounded deadline and a monotonic clock when available
- choose an interval appropriate to the system; avoid busy loops
- read fresh state on each attempt
- propagate unexpected errors instead of retrying every exception
- honor cancellation and clean up listeners, timers, and resources
- report the unmet condition and sanitized last observation on timeout

Do not introduce arbitrary sleeps to make a test pass. A deliberate delay is appropriate when elapsed time is itself the behavior under test, such as debounce or expiry. Document that purpose and prefer controlled time.

## Verify intermittency honestly

Run under the conditions that exposed the failure, including relevant concurrency or load. Record trial counts and failure frequency before and after the fix. A successful rerun does not, by itself, identify a cause or prove a race eliminated.
