# Writable child lanes

Read this before assigning a writable child or creating a temporary lane. The main skill owns delegation authority, task-wide limits, child restrictions, and final acceptance.

## Lease one isolated workspace

Give a writable child an explicit lease covering assigned files or an exclusive contract boundary, one isolated sibling workspace, and one branch or bookmark based on the canonical pull-request ref. Keep workspaces unnested and files exclusive to one writer.

A worker must request parent permission before editing an unassigned or claimed file. The parent explicitly changes the lease or keeps the file parent-owned.

When multiple writers are active, create each temporary lane through an owner-approved procedure. Stop if none exists. Use `${CANONICAL_REF}--lane-${LANE_KEY}` with a one-component lane key and a workspace leaf matching the ref's basename. Reserve `--lane-` for lanes, not canonical refs. Pass the canonical ref explicitly as base. A lane must neither default to trunk nor start from another lane.

## Integrate into one canonical ref

Temporary Git branches/worktrees and Jujutsu bookmarks/workspaces are implementation lanes, not separate pull-request workspaces. Workers may make lane-local integration commits; they never integrate their own work into the canonical ref.

The parent performs this sequence:

1. Inspect the lane diff and validation evidence.
2. Accept or reject the lane as a unit.
3. Rebase accepted lane work onto the current canonical ref when needed.
4. Fast-forward the canonical ref so accepted lane commits remain in its ancestry.
5. Resolve cross-lane conflicts in the canonical workspace.

Preserve accepted ancestry rather than squashing or copying changes. Start later changes in a new lane based on the updated canonical ref; a removed lane stays removed.

## Remove integrated lanes

Remove every integrated temporary lane before presenting the pull request. Use an owner-approved exact-lane cleanup procedure from the surviving canonical workspace. Stop if none exists.

The target must be the direct `${CANONICAL_REF}--lane-${LANE_KEY}` ref with its matching workspace leaf. Review its bound plan and apply only with confirmation and the matching plan ID.

The owner's initial authorization of temporary lanes for this current task also authorizes the parent to confirm their exact cleanup plans. This exception covers neither ordinary cleanup nor another task or unrelated workspace.

Stop cleanup for a dirty, active, locked, conflicted, detached, changed, unintegrated, inaccessible, or otherwise rejected lane. Retain and report it. Never force removal or widen the target.
