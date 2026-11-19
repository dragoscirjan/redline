# Decision examples

These are review scenarios, not executable tests. Confirm each scenario's assumptions against the actual project before acting.

| Scenario and evidence | Expected decision |
|---|---|
| A private factory and registry construct one concrete formatter. Callers, configuration, tests, and deployment wiring show no dynamic selection or extension contract. | Simplify to direct construction if it preserves lifecycle and errors. Do not invent future formatter variants to justify the registry. |
| A payment-service interface separates network calls from deterministic offline tests. Tests depend on substituting the service. | Keep the interface. Its testing boundary is a present requirement, even with one production implementation. |
| An established crypto dependency verifies signatures, and authorization checks protect operations independently of the UI. A proposal replaces both with shorter local logic. | Keep the library and checks. Fewer lines do not replace their security guarantees. |
| A plugin module has no static imports, but the package manifest registers it. A CLI is invoked by a deployment job outside the source tree. | Keep both entrypoints. Inspect registration and operational consumers before judging reachability. If those consumers cannot be inspected, defer removal. |
| A cache complicates invalidation, but load measurements show that removing it violates the documented latency target. | Keep the required optimization, or validate a simpler alternative against the same workload and correctness constraints before replacement. |
| A wrapper edit reveals unrelated packages that might also be simplified. | Stay within the wrapper's approved scope. Report the other candidates separately; do not start repository-wide cleanup. |
| The user asks for a review-only dependency audit. | Read manifests and consumers and report evidence and uncertainty. Do not edit lockfiles, run installers, or invoke mutation-capable checks. |
| A proposed dependency removal has no verified inventory of downstream users or recovery scripts. | Defer. Identify the missing consumer evidence rather than claiming the dependency is dead. |
| A review finds that every layer owns a distinct validated boundary and that replacing the design would move complexity into callers. | Keep the design and report a no-change result with the boundary evidence. |
