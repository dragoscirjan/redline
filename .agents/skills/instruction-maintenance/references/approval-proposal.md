# Exact instruction-adaptation proposal

Read this before presenting an instruction-adaptation proposal or treating a response as approval. The main skill limits eligible changes and owns the read-only audit.

## Show the complete change

Present all ten items before mutation:

1. The observed mismatch.
2. Evidence and the affected workflow.
3. Current behavior.
4. Proposed behavior.
5. Every file that would change.
6. Exact routing, policy, dependency, handoff, or metadata changes.
7. Effects on startup context and progressive disclosure.
8. Rules that remain unchanged.
9. Validation plan.
10. Intended issue, workspace, commit, and pull-request workflow.

Put any proposed change to a security boundary, mandatory gate, validation requirement, or owner authority under a separate **Protected-rule changes** heading. Obtain specific approval for it, not approval hidden inside a general request. Merge and release authority remains outside this adaptation workflow.

## Bind approval to the proposal

Ask the human to approve or reject the exact proposal. Approval must occur after it is shown and clearly refer to it.

Silence, lack of objection, approval of an earlier or materially different proposal, permission for the original task, a user correction, or a standing request to improve instructions is not approval of this proposal.

If evidence, affected files, scope, dependencies, handoffs, or protected rules change, discard the approval and present a revised proposal. Stop until new approval arrives.

## Check the approved application

Keep changes within the approved files and rules. Preserve phase handoffs as conditional pointers rather than eager dependencies. Update approved stale names, paths, catalogs, and examples together.

Apply the normal issue, task-branch, working-location, validation, commit, and pull-request gates. Stop and report deviations before continuing. Approval permits neither merge nor release.
