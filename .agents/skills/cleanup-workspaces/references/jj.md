# Jujutsu cleanup eligibility

Read this before auditing or applying Jujutsu cleanup. Require Jujutsu 0.38 or newer. The main workflow owns authorization, protected state, plan confirmation, and reporting.

## Working-copy eligibility

Require a conflict-free working-copy snapshot. Its exact commit must be integrated, or it must be empty with every parent integrated. Any matching local bookmark must be unambiguous and target the audited tip or an integrated parent. The ancestry query `<tip> & ::<base>` must select exactly the candidate commit.

`jj status` refreshes the working-copy snapshot during audit. This can update repository metadata without editing workspace files or refs. If that changes the audited commit, skip the workspace in this run and audit it again.

## Stale registrations

Treat a registration as stale only when `jj workspace root --name` resolves its registered root and that path is missing. If the root cannot be resolved, classify it as inaccessible and skip it. A missing derived path alone proves nothing.

Forgetting a proven stale registration preserves its bookmark and commit unless normal eligible-workspace checks independently authorize bookmark cleanup. Exact lane mode rejects stale registrations.

## Removal

Use `jj workspace forget`, then `jj bookmark forget` for an eligible local bookmark, then remove the exact confirmed original directory without force. Preserve commits; never use `jj abandon` or propagate bookmark deletion with `jj bookmark delete`.

Before every destructive step, revalidate the original registered path, directory identity, non-symlink state, and location inside the workspace root. Stop on substitution or changed state. Directory removal must not dereference a substituted path. Report partial failures rather than following another path.

For exact lane mode, run these operations from the surviving canonical workspace and apply the [lane identity checks](orchestration-lanes.md).
