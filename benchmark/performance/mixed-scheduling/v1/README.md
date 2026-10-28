# Fixed synthetic scheduling comparison

No model calls or wall-clock model measurements. The same 20 tasks, four workers, size estimates and durations are used for both policies:

- Four large tasks: 10,000 estimated diff bytes, 240 seconds each.
- Sixteen small tasks: 100 estimated diff bytes, 30 seconds each.
- Budgets: 180 and 600 seconds.
- Equal-size tasks use deterministic manifest-index ties; mixed alternates size extremes.

| Budget | Largest-first completed | Mixed completed | Largest-first elapsed | Mixed elapsed |
| --- | --- | --- | --- | --- |
| 180s | 0/20 | 3/20 | 180s | 180s |
| 600s | 20/20 | 20/20 | 360s | 360s |

`assignedCompletionMs` includes the full duration of assigned unfinished tasks; it is not elapsed time after a deadline. No task starts at/after the deadline. Other duration distributions can favor largest-first; this one corpus is not a general superiority or live-latency claim. Production defaults remain largest-first.

Implementation: `src/review/scheduling.ts` and `src/benchmark/scheduling.ts`. Contract: `test/scheduling.test.ts`. `report.json` records the inputs and deterministic outputs.
