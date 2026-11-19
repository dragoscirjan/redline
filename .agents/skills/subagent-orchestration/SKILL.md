---
name: subagent-orchestration
description: "Before delegating, bound child-agent work, assign read/write lanes, integrate results, review, validate, and clean temporary lanes."
compatibility: Requires a harness with child-agent support; writable parallel lanes also need owner-approved workspace creation and exact-lane cleanup procedures.
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# Subagent orchestration

Keep simple work parent-owned. Delegate only with task and harness authority, and when independent investigation, implementation, or review reduces risk or materially improves throughput. Complexity alone grants no permission.

The parent owns the complete task and final acceptance. Children report only to the parent and never become coordinators.

## 1. Bound the task

Across the whole user task, including follow-ups and replacements, allow at most three workers and two reviewers. Exclude the parent. Count failed, unsupported, cancelled, and replacement launches against their role's limit. Count every non-review child as a worker. These are limits, not quotas; only explicit owner instruction can raise them.

Prohibit child delegation in every child prompt. Task size, deadlines, and harness capacity do not expand the bounds.

Keep narrow, sequential, tightly coupled, or coordination-heavy work parent-owned. Use delegation for genuinely independent seams, read-only questions, separate platform checks, or fresh-context review. If support is unavailable or launch fails, report it and continue directly only when safe within scope.

## 2. Record the lane contracts

Before the first launch, record each lane's role, scope and acceptance contract, workspace/ref when writable, exclusive files or shared boundary, status, and launch count.

The parent owns scope, decomposition, the lane board, child communication, leases, conflicts, canonical ref/workspace, integration order and ancestry, validation, temporary-lane cleanup, and acceptance. Children cannot contact the owner, push, manage pull requests, merge, release, or present final acceptance.

Before assigning any reused lane, inspect its status and provenance. Confirm that all existing changes belong to this task and assigned owner. Preserve unrelated or uncertain work and stop assignment.

Read-only children may share a workspace only when their commands cannot mutate repository or generated state. Before assigning any writable child, read [writable lanes, integration, and cleanup](references/writable-lanes.md). For writable children, continue only with an exclusive lease and an owner-approved workspace procedure.

## 3. Integrate and review

Inspect child results against each lane contract. Integrate accepted writable work through the referenced canonical-ref procedure; preserve accepted ancestry.

A complex mutation normally receives one or two fresh-context, read-only reviewers after integration. Reviewers cannot edit, commit, or delegate. A requested two-axis review keeps Standards and Spec reviewers separate and reports both axes. Both count against the task-wide reviewer limit.

The parent adjudicates findings, applies fixes or delegates within remaining bounds, reruns relevant validation, and makes acceptance decisions.

## 4. Finish the task

For writable lanes, complete the referenced exact-lane cleanup before presenting the pull request. Retain and report a rejected lane rather than forcing removal.

Before the final response, verify task-wide counts, no nested delegation, accepted changes on the canonical ref, validation from that workspace, and removal of integrated temporary lanes. Disclose failed or unsupported delegation and retained lanes. Keep final acceptance and the final response parent-owned.
