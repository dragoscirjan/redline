---
name: plan-tasks
disable-model-invocation: true
description: Divide an agreed specification or clear scope into bounded, verifiable tasks with explicit dependencies and completion evidence.
---

# Plan tasks

Divide agreed work into tasks that another implementer can complete and verify without repeating the design discussion.

## 1. Establish the planning inputs

Resolve destination and format from the target project's `AGENTS.md` and `CONTRIBUTING.md`. Ask before drafting if either is unclear; let the user choose chat, files, or a tracker.

Read the full specification or agreed scope, relevant comments, and affected code and tests. A separate specification document is optional when direct scope is sufficient. Continue when the inputs and output location are settled.

## 2. Define reviewable deliverables

Size each task around a deliverable worth reviewing independently. Prefer a working end-to-end slice where it fits. Keep setup, tests, and documentation with the deliverable that needs them. Small work may need one task.

For every task, state its deliverable, boundaries, covered requirements, completion evidence, and results needed by later tasks. Include inspected paths or interfaces where useful. Record genuine blockers and unresolved decisions. Use only commands and interfaces supported by project evidence.

For wide refactors, use expand-contract sequencing when compatibility requires it. If steps cannot pass independently, name their shared integration check rather than claiming each passes alone.

## 3. Check coverage and hand off

Account for every in-scope requirement. Check dependency cycles and confirm that every completion check tests its promised result. Distinguish blocking dependencies from preferred ordering. Present the breakdown for review of task size and dependencies.

Stop at the plan or blocking questions and name the next ready task. Starting work, launching workers, or publishing beyond the agreed destination requires the applicable project gates and authorization.
