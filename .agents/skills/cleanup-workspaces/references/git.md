# Git cleanup eligibility

Read this before auditing or applying Git cleanup. The main workflow owns authorization, protected state, plan confirmation, and reporting.

## Registered worktrees

Require the same Git common directory, an empty `git status --porcelain=v1 --untracked-files=all`, and no active merge, rebase, cherry-pick, revert, or bisect. The registered HEAD, checked-out branch, and branch tip must match. Prove the exact tip is integrated with `git merge-base --is-ancestor <tip> <base>`.

Treat `git clean -ndX` output as an ignored-file deletion warning only. The helper never runs `git clean -f`.

Ordinary removal runs from the primary repository. It uses `git worktree remove <workspace-path>` and `git branch -d <branch>`, without force.

## Stale registrations

A missing registered worktree is stale. Git pruning is repository-wide. The helper may run `git worktree prune --expire now --verbose` only when every currently prunable registration lies inside the derived workspace root. If any registration is out of scope, disable all automatic Git pruning and report the limit.

After pruning, delete a stale branch only when its recorded tip remains unchanged and integrated.

## Exact lane mode

Require the registered path to equal the named sibling target. Prove its exact tip is an ancestor of canonical `HEAD` and the selected base. Run worktree removal and safe branch deletion from that surviving canonical workspace. This preserves primary-checkout protection and avoids force deletion.

Lane mode never runs repository-wide pruning. Apply the additional [lane identity checks](orchestration-lanes.md) before planning or removing a lane.
