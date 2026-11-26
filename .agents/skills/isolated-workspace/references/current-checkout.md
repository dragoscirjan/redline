# Use the current checkout

Read after selecting the current checkout. This procedure establishes the mandatory task ref without creating a worktree or workspace. Use only the explicitly selected VCS.

## Check the starting state

Confirm the current directory is the intended repository and inspect its status. For a new task, use a clean checkout and a new task ref. If unrelated changes or an uncertain task ref are present, stop and ask how to preserve that work. Do not clean, stash, reset, rename, or overwrite it to make this path possible.

For continuation, verify that the existing task ref and all current changes belong to the same task. Continue there without creating a second branch or change. Stop if ownership cannot be established.

Resolve the base and full task-ref name from the parent skill's input step. The examples below use illustrative names; substitute the resolved, reviewed values. Keep task edits blocked until creation or verified continuation succeeds.

## Git

Inspect the branch, status, and base:

```sh
TASK_REF='change/issue-42'
BASE='main'
git status --short
git branch --show-current
git check-ref-format --branch "$TASK_REF"
git rev-parse --verify "$BASE^{commit}"
git branch --list "$TASK_REF"
```

Continue only when the checkout is clean, the base resolves, and the new task branch does not exist. A matching name alone is not evidence of continuation. If this is a verified continuation, check that the current branch is the exact task branch instead of running creation.

For a new task, create and switch to its branch:

```sh
git switch --create "$TASK_REF" "$BASE"
git branch --show-current
git status --short
```

Require a successful switch, the exact task branch as the current branch, and a clean status. A failed switch leaves the setup incomplete; inspect the result and stop before edits. Preserve existing refs rather than forcing creation or switching another worktree's branch.

## Jujutsu

Inspect the change, file differences, base, and bookmark:

```sh
TASK_REF='change/issue-42'
BASE='trunk()'
jj status
jj diff --summary
jj log --revisions "$BASE" --no-graph
jj bookmark list "$TASK_REF"
```

Continue only when the working copy has no file changes, the base resolves to one revision, and the new bookmark does not exist. For verified continuation, require the task bookmark to identify the current working-copy change and verify ownership of its existing changes; skip creation.

For a new task, create a dedicated change and bookmark:

```sh
jj new "$BASE" --message "$TASK_REF"
jj bookmark create "$TASK_REF" --revision @
jj log --revisions @ --no-graph
jj bookmark list "$TASK_REF"
jj status
```

Require both commands to succeed, the exact task bookmark at `@`, and no file changes before edits. If bookmark creation fails after change creation, stop and report the partial setup. Preserve the new change and existing bookmarks for an explicit recovery decision.

## Finish

Report the selected VCS, resolved base, task ref, absolute current directory, and status. State that no separate workspace was created. Return to the parent skill's handoff only after the ref and working directory are verified.
