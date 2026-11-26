---
name: specify
disable-model-invocation: true
description: Turn agreed decisions into a compact specification with observable behavior, acceptance criteria, constraints, and test boundaries.
requires: ["grilling"]
---

# Specify

Record agreed behavior so implementation and review share the same requirements. Writing the specification is not permission to make new decisions.

## 1. Resolve the requirements

Read source requirements, relevant issue comments, and confirmed answers. Inspect available code, contracts, and tests. Use the project's vocabulary and recorded architectural decisions. Use existing context when it is available.

Use the required interview for unresolved behavior, constraints, contract values, or test expectations. Reuse confirmed answers and inspect available facts yourself. Obtain agreement for any change to the agreed scope. Return to clarification whenever another material decision appears.

Continue only when the requirements and test boundaries are settled. Report blockers instead of speculative requirements.

## 2. Define observable correctness

Cover intended behavior, scope, exclusions, constraints, success, relevant failures, and boundary cases. Give acceptance criteria stable identifiers and observable results.

Capture agreed module, interface, API, or schema decisions where they matter. Preserve exact agreed values. Use stable contracts rather than guessed file paths or unnecessary code snippets.

Identify where tests can observe every required behavior. Prefer existing interfaces and examples; settle new test boundaries with the user. Continue when a fresh reader can determine correctness without guessing.

## 3. Choose the specification record

Resolve destination and format from the request and applicable `AGENTS.md` and `CONTRIBUTING.md`. Ask if either is unclear. Confirm whether to create or update an issue, document, or section. Continue when the exact destination and operation are authorized.

## 4. Save, verify, and stop

Save source references, settled requirements and test boundaries, draft or agreed status with evidence, and the next authorized action. Verify the saved content and report its actual path or URL, format, and status. Say when verification is unavailable.

If saving is blocked, provide the prepared content marked "not saved" and explain what is needed. Stop at the specification handoff. Creating tasks, implementing behavior, or publishing beyond the agreed destination requires separate authorization under project gates. Specification agreement does not authorize execution.
