---
name: instruction-maintenance
description: Diagnose and propose human-approved updates when agent instructions, deferred-document relationships, or skill routing metadata are missing, stale, conflicting, duplicated, or unsuitable for the observed workflow. Use when repository instructions no longer fit the work. Loading this skill authorizes a read-only audit and exact proposal, not mutation.
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# Maintain agent instructions

Detect instruction drift and propose the smallest correction. Do not modify instructions until a human explicitly approves the exact proposal.

Loading or invoking this skill authorizes read-only inspection, diagnosis, and proposal preparation only. It does not authorize repository mutation, issue creation, branch creation, commits, pushes, pull requests, merges, or releases.

## Recognize instruction drift

Use this workflow when evidence shows that one or more of these conditions apply:

- A required workflow has no route.
- A route points to a missing or renamed document or skill.
- Two instructions conflict or claim the same responsibility.
- The same rule is duplicated across instruction layers.
- A trigger is too broad, too narrow, or assigned to the wrong phase.
- A required dependency is missing or circular.
- A later-phase handoff is treated as an always-loaded dependency.
- Skill routing metadata no longer describes when the skill should load.
- The observed workflow cannot follow the current instructions as written.

Treat a user correction, failed workflow, review comment, or external example as evidence to inspect. Do not treat it as authority to rewrite policy.

## Limit the adaptive scope

This workflow may propose changes to:

- startup routing in `AGENTS.md`
- deferred project instruction documents, such as contribution and validation policy
- instruction dependency and phase-handoff statements
- skill routing metadata, including `name` and `description`
- catalogs and references that must change with approved routing metadata

This workflow must not change:

- detailed skill procedures or behavior
- application code or unrelated configuration
- security boundaries, mandatory workflow gates, or owner authority without a separately identified protected-rule proposal
- merge or release authority

Use the normal contribution workflow for changes outside this scope.

## Audit without mutation

Read the nearest applicable startup instructions and only the deferred documents needed to understand the mismatch. Inspect skill frontmatter before reading complete skill instructions. Do not preload every skill.

Build a small instruction graph. Classify each relationship as one of these types:

- **Trigger route:** an event or phase requires a document or skill.
- **Required dependency:** one instruction cannot operate correctly unless another instruction loads with it.
- **Phase handoff:** another instruction loads only when a later phase begins.
- **Reference:** a link provides context but does not require loading.

Check the graph for:

- missing targets and stale names or paths
- conflicting, duplicated, unreachable, or ambiguous rules
- dependency cycles
- triggers that load too much context
- mandatory instructions that rely only on optional model selection
- skill names that do not match their directories
- descriptions that do not state what the skill does and when it applies
- rules that weaken security, mutation gates, validation, or owner authority

If the mismatch affects a mandatory gate or safe execution of the current task, stop the affected phase. If the mismatch is nonblocking, continue only when the existing instructions still give an unambiguous safe path.

## Present the exact proposal

Before any mutation, show the human:

1. The observed mismatch.
2. The evidence and affected workflow.
3. The current behavior.
4. The proposed behavior.
5. Every file that would change.
6. The exact routing, policy, dependency, handoff, or metadata changes.
7. Any effect on startup context or progressive disclosure.
8. The rules that remain unchanged.
9. The validation plan.
10. The intended issue, workspace, commit, and pull-request workflow.

List any change to a security boundary, mandatory gate, validation requirement, or owner authority under a separate **Protected-rule changes** heading. Do not include such a change under a general approval request.

Ask the human to approve or reject this exact proposal. A valid approval must occur after the proposal is shown and must clearly refer to it.

These responses do not authorize mutation:

- silence or lack of objection
- approval of an earlier or materially different proposal
- permission for the original task
- a user correction without approval to change repository instructions
- a standing request to improve instructions when useful

If evidence, affected files, scope, or protected rules change, discard the approval and present a revised proposal.

## Apply an approved adaptation

After valid approval:

1. Create or link the issue required by the repository policy.
2. Load and follow the repository's contribution, isolated-workspace, and validation instructions at their normal phase gates.
3. Make only the approved changes.
4. Keep startup instructions compact. Put detailed reusable procedures in skills or deferred documents.
5. Preserve progressive disclosure. Do not convert a phase handoff into an eager dependency.
6. Update all approved stale names, paths, catalogs, and examples.
7. Run every applicable validation check.
8. Report any deviation from the approved proposal and stop before continuing with that deviation.

Approval to adapt instructions is not permission to merge or release. Follow the repository's owner-authority rules.

## Report the result

State:

- the approved proposal
- changed files
- instruction-graph effects
- checks that passed, failed, or did not run
- unresolved drift or follow-up work
- whether the active harness must reload to discover changed instructions or skill metadata

Do not claim that future sessions use the new instructions until the change is integrated and the harness has reloaded them.
