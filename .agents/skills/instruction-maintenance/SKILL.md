---
name: instruction-maintenance
description: "Audit instruction drift, routing, and skill metadata; propose exact changes for human approval before mutation."
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# Maintain agent instructions

Inspect instruction drift and propose the smallest correction. Loading this skill authorizes read-only audit and proposal preparation only. Repository changes require the human's explicit approval after the exact proposal is shown.

## 1. Establish the mismatch

Use observed evidence such as a user correction, failed workflow, review comment, or external example. Check missing routes or targets, conflicting or duplicated rules, phase-inappropriate triggers, missing or cyclic dependencies, eager later-phase handoffs, stale metadata, and workflows that cannot follow their instructions.

Read applicable startup instructions and only the deferred documents needed to investigate. Inspect skill frontmatter before full instructions; load only relevant skills. Continue when the mismatch and affected workflow have concrete evidence. Evidence is not authority to change policy.

## 2. Audit the instruction graph

Classify relationships as trigger routes, required dependencies, phase handoffs, or references. Check target existence, naming, cycles, context load, ambiguity, and clear descriptions of purpose and invocation. A mandatory gate must have a mandatory route rather than rely on optional model selection.

Limit this adaptation workflow to startup routes, deferred project instruction documents, dependency/handoff statements, routing metadata, and catalogs or references that must change with that metadata. Detailed skill procedures, application code, and unrelated configuration belong to the normal contribution workflow.

Preserve security boundaries, mandatory gates, validation, and owner authority unless a protected-rule change is separately proposed. Merge and release authority remains outside this workflow.

If a mismatch blocks a mandatory gate or safe execution, stop that phase. Continue around a nonblocking mismatch only when an unambiguous safe path remains.

## 3. Present and bind approval

Read the [exact-proposal and approval contract](references/approval-proposal.md) before presenting a proposal or interpreting a response as approval. Show every affected file and exact rule or metadata change. Identify protected-rule changes separately.

Stop until the human explicitly approves that proposal. Audit permission, a correction, the original task, standing improvement requests, silence, or approval of a different proposal grants no mutation authority.

Approval covers only its stated files and rules. Changed evidence, scope, dependencies, handoffs, or protected rules require a revised proposal and new approval.

## 4. Apply only the approved adaptation

After approval, create or link the required issue and follow contribution, isolated-workspace, validation, commit, and pull-request gates. Keep startup instructions compact, detailed workflows deferred, and phase handoffs conditional. Update approved stale paths, names, catalogs, and examples together.

Run every applicable check. Stop and report any deviation before proceeding outside the approved proposal. Approval grants no merge or release authority.

## 5. Report the result

Report the approved proposal, changed files, graph effects, passed/failed/unrun checks, unresolved drift, and any harness reload required. Claim future-session adoption only after integration and reload.
