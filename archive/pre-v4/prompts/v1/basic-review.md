# Basic review phase

Review the changed behavior for concrete correctness, regression, compatibility, and test-coverage problems.

Check relevant concerns, including:

- incorrect logic, conditions, calculations, or edge-case handling;
- violated API, data, serialization, configuration, or command contracts;
- incorrect error propagation, fallback behavior, or cleanup;
- invalid state transitions or lifecycle ownership;
- data loss, corruption, duplication, or stale state;
- concurrency, ordering, retry, timeout, or idempotency defects;
- backward-incompatible behavior that the change does not account for;
- missing validation at a changed boundary;
- missing tests for a credible failure in externally meaningful changed behavior.

A testing finding must identify the changed behavior, a credible regression, why existing coverage would miss it, and the specific case that should be tested. Do not ask for tests merely to increase coverage.

Report an obvious security defect found during this phase. The security phase must not publish it again.
