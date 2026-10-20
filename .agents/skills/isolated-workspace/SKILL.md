---
name: isolated-workspace
description: Plan, create, or reuse one isolated Git worktree or Jujutsu workspace before repository mutation. Use before architecture, code, documentation, configuration, or policy changes. Requires an explicit VCS and branch or bookmark name while detecting repository and workspace paths automatically.
compatibility: Requires Bun and either Git with worktree support or Jujutsu 0.38 or newer with workspace support.
metadata:
  author: dragoscirjan
  version: "2.0"
  opencode/slash: "true"
---

# Isolated workspace

Establish a dedicated workspace before the first repository mutation. Do not edit, generate, move, or delete repository files until this gate passes.

Use the bundled TypeScript automation. Do not recreate its path derivation or VCS procedures manually.

## Read project configuration

Read the nearest applicable `AGENTS.md`. Obtain:

- the VCS selected by the project or owner
- the base revision, when the project configures one
- the full branch or bookmark name for the tracked change

The script must receive `--vcs git` or `--vcs jj`. It never infers the VCS, including in a colocated repository. Do not mix Git and Jujutsu commands.

Pass the full branch or bookmark name through `--branch`. Apply the configured prefix before invoking the script. For example, use `--branch change/issue-42`, not only `issue-42`.

Pass a configured base through `--base`. When it is omitted, the script uses the Git remote default branch, then the current Git branch, or `trunk()` for Jujutsu.

Bun runs the helper but is not added to the target repository. If Bun or the selected VCS is unavailable, stop. Do not install or reconfigure tools without owner approval.

## Plan the workspace

Resolve this skill's directory, then run:

```sh
bun <skill-directory>/scripts/create.ts \
  --vcs git \
  --branch change/issue-42 \
  --base main
```

Use `--vcs jj` for Jujutsu. The default is a JSON plan. `--dry-run` is an optional explicit alias for plan mode.

The script detects the repository that contains the current directory. It identifies the primary Git worktree or the Jujutsu `default` workspace, then derives:

```text
workspace root = <primary repository parent>/<primary repository name>--workspaces
workspace path = <workspace root>/<final branch component>
workspace name = <final branch component>
```

For `change/issue-42` in `/work/project`, the derived path is `/work/project--workspaces/issue-42`.

The script rejects unsafe names, path escapes, symlinked workspace roots, unregistered destination collisions, conflicting workspace names, and branches attached elsewhere. It does not use hosted-repository identity or a remote URL to derive local paths.

Review the plan. Confirm that it reports the intended:

- VCS
- primary repository
- base revision and resolved commit
- full branch or bookmark
- workspace name and absolute path
- create, attach, repair, or reuse action
- exact VCS commands
- the `planId` that binds apply mode to this exact plan

## Protect existing work

- Never mutate the primary checkout.
- Never stash, reset, clean, move, or delete pre-existing changes.
- Keep one active writer per workspace.
- Do not create a nested workspace.
- Treat a branch, bookmark, workspace-name, or path collision as a stop.
- Reuse only an exact registered path and branch or bookmark match.
- Before continuing in a reused workspace, inspect its status and confirm that existing changes belong to the current task. The script cannot determine task ownership.

## Apply the approved plan

After the human approves the exact plan, rerun the same command with both mutation gates:

```sh
bun <skill-directory>/scripts/create.ts \
  --vcs git \
  --branch change/issue-42 \
  --base main \
  --apply \
  --confirm \
  --plan-id PLAN_ID
```

Replace `PLAN_ID` with the value emitted by the approved plan-mode run. Apply mode requires `--apply`, `--confirm`, and the matching `--plan-id`. It rebuilds the plan before mutation and stops if the approved plan ID, action, path, or resolved base changed.

For Git, it either:

- creates the branch from the base and adds its worktree, or
- attaches an existing branch only when it is not attached elsewhere.

For Jujutsu, it:

1. adds a named workspace from the base
2. describes its working-copy change with the full bookmark name
3. creates the full bookmark at `@`

A later run is idempotent when the registration, path, and branch or bookmark still match. It can repair a missing Jujutsu bookmark only when the exact registered workspace's description equals the requested full bookmark name. It never overwrites a bookmark.

## Verify the gate

Require successful apply output or an exact reusable workspace. Then verify and report:

- selected VCS
- absolute workspace path
- resolved base
- branch or bookmark
- current status

Run every subsequent read, write, command, validation, commit, and publication step from the isolated workspace. When tools do not preserve `cd`, pass the absolute workspace path as their working directory.

## Output and failures

JSON is the default output. Use `--format text` for a concise human-readable report. Diagnostics are bounded and redact common credential-bearing values.

Exit codes are:

- `0`: success
- `2`: invalid arguments or missing confirmation
- `3`: state, identity, or path conflict
- `4`: missing environment prerequisite
- `5`: VCS command failure
- `6`: filesystem or unexpected failure

## Cleanup handoff

Do not remove the workspace here. When the owner asks to clean completed workspaces, load and follow the `cleanup-workspaces` skill. Creation does not authorize cleanup, merge, or release.
