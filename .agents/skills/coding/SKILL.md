---
name: coding
description: Design, implement, refactor, review, or test code with project-first conventions, contextual engineering principles, risk-based security, behavior-focused tests, and applicable quality gates. Use for any task that writes or changes code in any language. Combine it with the matching coding language or extension skills when available.
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# Coding

Produce the smallest correct change that fits the project. Preserve behavior and compatibility unless the task explicitly changes them.

Use engineering principles as decision tools, not rituals. Do not add abstractions, patterns, dependencies, or infrastructure merely to make code look sophisticated.

## Understand the project first

Before changing code:

1. Read the applicable project instructions.
2. Inspect nearby code, public interfaces, tests, build files, tool configuration, and CI commands.
3. Identify the language, runtime, deployment environment, compatibility requirements, and trust boundaries.
4. Load the matching `coding-*` skills when the harness advertises them.
5. Prefer established project architecture, terminology, tools, and conventions unless they are unsafe or conflict with the task.

Do not install, replace, or reconfigure development tools without human approval.

## Choose the smallest sound design

Apply these principles in context:

- **KISS:** Prefer the simplest design that handles the known requirements and failure modes.
- **YAGNI:** Do not build extension points or generalized infrastructure for hypothetical needs.
- **DRY:** Remove duplication when the repeated concept is stable. Do not merge code that only looks similar.
- **SOLID:** Use these principles when object-oriented boundaries benefit from them. Do not create interfaces or classes solely to satisfy an acronym.
- **Design patterns:** Use a pattern only when it solves a demonstrated recurring problem better than a direct implementation.

Keep responsibilities cohesive and dependencies explicit. Prefer composition over inheritance when both express the domain equally well. Introduce indirection only when it reduces coupling, isolates volatility, or enables a required test boundary.

For simple work, prefer pure functions, immutable values, explicit inputs and outputs, and a functional core with side effects at the boundaries when that style is idiomatic. Use procedural, object-oriented, concurrent, or stateful designs when they make ownership, performance, or domain behavior clearer.

## Implement clearly

- Use names that describe domain intent.
- Keep functions and modules focused on one coherent responsibility.
- Make state changes and side effects visible.
- Handle errors at the layer that can add context or recover. Do not silently discard failures.
- Preserve invariants at module and API boundaries.
- Minimize new dependencies and use standard-library features when they are sufficient.
- Comment decisions, constraints, and non-obvious risks. Do not narrate obvious code.
- Keep public APIs backward compatible unless the approved change says otherwise.
- Remove dead code introduced by the change, but do not broaden cleanup beyond the task.

## Apply risk-based security

Identify what is trusted, what is untrusted, and what the code protects. Apply controls that match the actual risk.

- Validate untrusted input at the boundary where it enters the system.
- Encode output for its destination context.
- Use structured APIs and argument arrays for queries, commands, and subprocesses. Do not build them through untrusted string interpolation.
- Enforce authorization at the protected operation, not only in the user interface.
- Use least privilege and deny by default when access is uncertain.
- Keep secrets out of source code, logs, errors, tests, and generated artifacts.
- Use established cryptographic libraries and protocols. Do not design custom cryptography.
- Bound resource use, handle timeouts and cancellation, and release resources on every path.
- Check memory, integer, concurrency, path, serialization, and dependency risks when they apply to the language and environment.
- Return useful errors without exposing sensitive internals.

Use the [OWASP Developer Guide](https://devguide.owasp.org/), its [secure coding checklist](https://devguide.owasp.org/en/04-design/02-web-app-checklist/), and the [CWE Top 25](https://cwe.mitre.org/top25/) as risk references, not as substitutes for project-specific threat analysis.

Do not claim that code is secure because it follows a checklist or passes one scanner.

## Test changed behavior

Add or update tests when behavior changes.

- Test public behavior and observable contracts rather than implementation details.
- Cover the normal path, relevant boundaries, expected failures, and security regressions.
- Keep tests deterministic and isolated from uncontrolled time, randomness, network, and process state.
- Use integration tests where unit tests cannot verify the real boundary.
- Do not delete, weaken, skip, or over-mock tests to make a change pass.
- Follow existing project coverage thresholds. Do not invent a universal percentage.

## Run applicable quality gates

Discover the project's configured commands before choosing tools. Use project configuration and CI behavior first.

Run applicable gates in a useful order:

1. Formatting check.
2. Compilation or type checking.
3. Linting and static analysis.
4. Focused tests for the changed area.
5. The broader applicable test suite.
6. Duplicate-code detection.
7. Security analysis.
8. Dependency or package audit.

Use the project's duplicate detector when configured. Otherwise use [jscpd](https://jscpd.dev/) as the cross-language fallback when it is available or the human approves installing it. Apply only project-defined duplication thresholds.

Do not install a missing gate, change its configuration, lower a threshold, add a suppression, or run a broad automatic fix without approval. Inspect every automatic edit before keeping it.

Report each applicable gate as:

- **passed**
- **failed**, with the relevant failure
- **not run**, with the reason
- **unsupported**, when the ecosystem or project has no suitable gate

Never describe an unavailable, unsupported, or unexecuted gate as passed.

## Finish the change

Review the complete diff. Confirm that the change:

- satisfies the requested behavior
- follows the project's architecture and language guidance
- does not include unrelated edits
- updates affected documentation and examples
- preserves security and compatibility constraints
- reports all validation limits and remaining risks
