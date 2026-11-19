---
name: coding
description: "Design, implement, refactor, review, or test code under project conventions, risk-based security, and behavior-focused checks."
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# Coding

Produce the smallest correct change that fits the project. Preserve behavior and compatibility unless the approved task changes them.

## 1. Establish the project constraints

Read applicable instructions, nearby code, public interfaces, tests, build files, tool configuration, and CI. Identify languages, runtimes, deployment, compatibility, trust boundaries, and applicable language/extension constraints.

Use established architecture, terminology, tools, and conventions unless unsafe or inconsistent with the task. Tool installation, replacement, and reconfiguration need human approval. Continue when the requested behavior and applicable constraints are clear.

## 2. Choose the design

Use principles to answer concrete design questions:

- KISS favors the simplest design covering known requirements and failure modes.
- YAGNI keeps hypothetical extension points and generalized infrastructure out of the change.
- DRY combines a stable repeated concept, not code that merely looks similar.
- SOLID helps where object-oriented boundaries benefit; it does not justify otherwise unnecessary classes or interfaces.
- A design pattern earns its place by solving a demonstrated recurring problem better than direct code.

Keep responsibilities cohesive and dependencies explicit. Prefer composition when it expresses the domain as clearly as inheritance. Add indirection only to reduce coupling, isolate volatility, or enable a required test boundary.

For simple work, prefer pure functions, immutable values, explicit inputs/outputs, and a functional core with side effects at its boundaries where idiomatic. Use procedural, object-oriented, concurrent, or stateful designs when ownership, performance, or domain behavior benefits.

Continue when the design covers the known requirements without speculative mechanisms.

## 3. Implement clearly

- Use domain names and focused functions/modules.
- Make state changes and side effects visible. Preserve module and API invariants.
- Handle errors where context or recovery is available; propagate failures rather than discarding them.
- Use standard-library features when sufficient and keep new dependencies justified.
- Comment decisions, constraints, and non-obvious risks rather than narrating obvious code.
- Preserve public API compatibility unless its change is approved.
- Remove dead code introduced by this change while leaving unrelated cleanup out of scope.

## 4. Apply controls to actual risks

Identify trusted and untrusted data and what the code protects. Apply every relevant control:

- Validate input where untrusted data enters, and encode output for its destination.
- Use structured query APIs and subprocess argument arrays rather than interpolating untrusted values into executable strings.
- Enforce authorization at the protected operation. Use least privilege and deny uncertain access by default.
- Keep secrets out of source, logs, errors, tests, and generated artifacts.
- Use established cryptographic libraries and protocols, never custom cryptography.
- Bound resource use, handle timeouts and cancellation, and release resources on every path.
- Check applicable memory, integer, concurrency, path, serialization, and dependency risks.
- Return useful errors without sensitive internals.

Consult the [OWASP Developer Guide](https://devguide.owasp.org/), [secure coding checklist](https://devguide.owasp.org/en/04-design/02-web-app-checklist/), and [CWE Top 25](https://cwe.mitre.org/top25/) where relevant. These support project-specific threat analysis; one checklist or scanner is not proof of security.

## 5. Test changed behavior

Add or update tests for behavior changes. Cover public behavior and observable contracts, normal paths, relevant boundaries, failures, and security regressions. Use integration tests where unit tests cannot verify the boundary.

Keep tests deterministic and isolated from uncontrolled time, randomness, network, and process state. Preserve meaningful coverage instead of deleting, weakening, skipping, or over-mocking tests to obtain a pass. Apply project coverage thresholds rather than inventing a percentage.

## 6. Run the quality gates

Discover configured commands and CI behavior before choosing tools. Run applicable checks in this order:

1. Formatting.
2. Compilation or type checking.
3. Linting and static analysis.
4. Focused tests.
5. The broader applicable test suite.
6. Duplicate-code detection.
7. Security analysis.
8. Dependency or package audit.

Use the configured duplicate detector. Otherwise use [jscpd](https://jscpd.dev/) when available or when the human approves installing it. Apply only project-defined thresholds.

Obtain approval before installing a gate, changing its configuration, lowering thresholds, adding suppressions, or running broad automatic fixes. Inspect every automatic edit before retaining it.

Report every applicable gate as passed, failed with the failure, not run with its reason, or unsupported when no suitable ecosystem/project gate exists. Only an executed successful check passes.

## 7. Finish

Review the full diff against requested behavior, project architecture and language guidance, scope, affected documentation/examples, security, and compatibility. Finish only when each applicable check is accounted for and remaining risks or validation limits are reported.
