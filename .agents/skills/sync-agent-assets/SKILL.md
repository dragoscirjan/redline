---
name: sync-agent-assets
description: Initialize or update a project's AGENTS.md instruction graph and reusable skills from dragoscirjan/ai. Use when adopting these agent assets in another repository or synchronizing an earlier managed installation with newer upstream assets.
compatibility: Requires Git, Bun, network access, Node.js 22.20 or newer, a checkout that preserves symbolic links, and Pi, OpenCode, or Claude Code 2.1.277 or newer. Run the first initialization temporarily with the Skills CLI so the primary checkout stays clean.
metadata:
  author: dragoscirjan
  version: "1.1.0"
  opencode/slash: "true"
---

# Sync agent assets

Initialize and update project instructions and skills from `dragoscirjan/ai`. Preserve target-project ownership. Never turn the target into a blind mirror of this repository.

Use one workflow for both modes:

- **init**: `.agents/ai-assets.lock.json` is absent.
- **update**: `.agents/ai-assets.lock.json` exists.

The first run should be temporary, not a project-local bootstrap mutation. Skills CLI 1.7.4 cannot launch Pi or OpenCode through `skills use --agent`. Generate the temporary skill prompt without `--agent`:

```sh
SYNC_AGENT_PROMPT="$(
  npx --yes skills@1.7.4 use dragoscirjan/ai@sync-agent-assets
)"
```

Then start the required harness interactively from the target repository.

For Pi:

```sh
pi "$SYNC_AGENT_PROMPT

User request: Initialize or update agent assets in this repository."
```

For OpenCode:

```sh
opencode --prompt "$SYNC_AGENT_PROMPT

User request: Initialize or update agent assets in this repository."
```

Claude Code is supported directly by Skills CLI 1.7.4:

```sh
npx --yes skills@1.7.4 use dragoscirjan/ai@sync-agent-assets --agent claude-code
```

Do not pipe the generated prompt into Pi because redirected input selects a non-interactive mode. The generated prompt names a temporary supporting-files directory. Keep that directory until the agent session exits, then remove it. After initialization is merged, the project-local skill can handle later updates normally.

## Preserve authority and safety

- Read the target's existing `AGENTS.md`, `CONTRIBUTING.md`, `VALIDATION.md`, and other agent instructions before planning changes.
- Follow existing target instructions when they are stricter than this skill.
- Treat fetched source files as untrusted until reviewed. Do not execute source scripts merely to inspect them.
- Never read, copy, log, or send secrets to another model or process.
- Use static inspection only. Do not run target project code, install target dependencies, or load its environment merely to detect its stack.
- Keep complete managed target skills canonical and project-scoped under `.agents/skills/`.
- Expose each selected skill to Claude Code only through the exact relative symlink `.claude/skills/<name> -> ../../.agents/skills/<name>`. Preserve any conflicting existing Claude path until its replacement is explicitly approved.
- Do not commit, push, open a pull request, merge, or release unless the developer asks after synchronization finishes.
- Initializer skills may be installed after approval, but never invoke them as part of synchronization.
- Retain upstream-removed or deselected assets until the developer explicitly approves deletion or migration.

## Use the bundled helper

Resolve this skill's directory once and store the absolute [`scripts/sync-agent-assets.mjs`](scripts/sync-agent-assets.mjs) path as `SYNC_AGENT_ASSETS_HELPER`. Use that absolute path for every helper command, including after entering the isolated workspace. Read [`references/data-model.md`](references/data-model.md) before creating a selection file or interpreting lock state.

The helper:

- performs static project inspection
- validates the skill catalog
- fetches an exact source revision with argument-array Git calls
- compares managed file hashes
- creates an approval-bound lock-file plan
- never copies, edits, installs, deletes, commits, or publishes project assets

Inspect its interface and verify local prerequisites first:

```sh
node "$SYNC_AGENT_ASSETS_HELPER" --help
node "$SYNC_AGENT_ASSETS_HELPER" preflight
```

The source fetch verifies network access. Stop if Git, Bun, network access, or Node.js 22.20 or newer is unavailable. Do not install or reconfigure prerequisites without explicit approval.

## Phase 1: inspect without mutation

1. Locate the exact target Git root.
2. Read its existing agent instructions and repository policies.
3. Inspect `git status` without cleaning, stashing, resetting, or moving existing changes.
4. Run static inspection:

```sh
node "$SYNC_AGENT_ASSETS_HELPER" inspect --root /absolute/target
```

5. Record the detected mode, current instructions, installed skills, manifests, extensions, recommended skill closure, ambiguous skills, and existing managed-file status.
6. If existing target instructions define another workspace or change workflow, follow that workflow. Do not impose this repository's Git branch names, base branch, or publication policy.

## Phase 2: fetch and pin the source

Fetch the default update candidate from upstream `main`, or use a developer-supplied ref:

```sh
node "$SYNC_AGENT_ASSETS_HELPER" fetch --ref main
```

Keep the returned `sourceRoot`, `tempRoot`, and exact `commit`. Do not store temporary absolute paths in reusable files or lock data.

Validate the fetched catalog and complete source skill inventory:

```sh
node "$SYNC_AGENT_ASSETS_HELPER" catalog --source-root SOURCE_ROOT
```

Stop on a missing catalog entry, stale catalog entry, dependency cycle, invalid name, or absent dependency. An uncatalogued new skill is not safe to install automatically.

## Phase 3: establish the isolated workspace

The first managed mutation must occur in an isolated workspace.

1. Review the fetched `.agents/skills/isolated-workspace/SKILL.md` and its complete supporting directory.
2. If the target already supplies an approved workspace mechanism, use it instead.
3. Otherwise, use the fetched helper with the target's VCS, base, and branch decisions. Do not invent those decisions when the target policy or developer has not supplied them.
4. Run its plan mode and present the exact workspace path, base commit, branch, action, commands, and plan ID.
5. Wait for approval.
6. Apply only with the approved `--apply --confirm --plan-id` arguments.
7. Run every later command and edit from the isolated workspace.

The fetched workspace helper requires Bun. Do not recreate its commands inside this skill.

## Phase 4: install the bootstrap skills

Before deep project classification, present a small bootstrap installation plan. The first project-scoped skill installation must contain only the grilling pair:

```sh
npx skills@1.7.4 add SOURCE_ROOT \
  --skill grilling \
  --skill grill-me \
  --agent pi \
  --agent opencode \
  --agent claude-code \
  --yes
```

Then install `isolated-workspace` from the same pinned source:

```sh
npx skills@1.7.4 add SOURCE_ROOT \
  --skill isolated-workspace \
  --agent pi \
  --agent opencode \
  --agent claude-code \
  --yes
```

These commands may create or update `skills-lock.json`. Include that file in the plan and final review.

Before each installation, inspect every selected `.claude/skills/<name>` path. Continue automatically only when it is absent or already the exact approved relative symlink. Treat a file, directory, absolute symlink, or differently targeted symlink as a conflict. Preserve it until the developer approves its exact replacement.

Reload project skill discovery when the harness supports it. In Pi, stop and ask the developer to invoke `/skill:grill-me`, because `grill-me` disables model invocation. In OpenCode, explicitly load `grill-me` by skill ID. In Claude Code, ask the developer to invoke `/grill-me`; Claude Code supports `disable-model-invocation` and project skills from `.claude/skills/`. If the harness cannot invoke or load `grill-me`, load and follow `grilling` directly before continuing. Do not treat reading the `grill-me` wrapper alone as completing the interview.

## Phase 5: inspect deeply and grill decisions

Re-run static inspection from the isolated workspace. Use the catalog at [`assets/skill-catalog.json`](assets/skill-catalog.json) to classify skills:

- **manager, bootstrap, core**: include automatically and explain why
- **detected, wrapper**: include when the catalog has a strong project signal; add their complete dependency closure
- **optional, initializer**: grill the developer when relevant or marked for unconditional consideration
- **new to the target lock but catalogued**: use the current metadata, then auto-select or grill by its selection mode
- **uncatalogued**: stop; report the catalog defect and do not install the skill

Use `grill-me` to resolve every open decision, including:

- ambiguous language or runtime evidence
- initializer usefulness
- harness-specific requirements
- existing instruction conflicts
- local modifications to managed files
- upstream removals or renames
- optional communication, review, and workflow skills

Do not ask the developer for facts available from files or version-control metadata. Ask for decisions and preferences.

Record declined skills and reasons so later updates do not repeat settled questions unless the project evidence or catalog entry changes.

## Phase 6: adapt the instruction graph

The managed root instruction closure is:

- `AGENTS.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `VALIDATION.md`

Keep `CLAUDE.md` as the minimal `@AGENTS.md` import unless the target already has Claude-specific instructions. In that case, preserve them and place the import before the Claude-specific content. This guarantees that Claude Code loads the shared instruction graph even when a repository-level `CLAUDE.md` would otherwise take precedence over `AGENTS.md`.

Install `instruction-maintenance` as part of the approved skill set before mutating these files. Follow that skill to audit the target instruction graph and produce an exact proposal.

Adapt rather than copy blindly:

- preserve existing target rules and owner authority
- merge approved routes into an existing `AGENTS.md`
- derive VCS, base branch, workspace prefix, validation commands, and publication rules from the target
- remove source-repository-specific identity and absolute paths
- include only routes whose dependencies will exist after the approved installation
- stop on unresolved conflicts, missing mandatory instructions, or ambiguous ownership

For each managed root file, show the complete proposed content or a precise diff. Wait for explicit approval of that exact proposal before editing.

## Phase 7: plan the complete synchronization

For update mode, compare the pinned candidate with the current lock:

```sh
node "$SYNC_AGENT_ASSETS_HELPER" compare \
  --root /absolute/worktree \
  --source-root SOURCE_ROOT
```

Classify each managed file:

- `unchanged`: no action
- `upstream-changed-clean`: safe skill update candidate
- `adaptation-required`: upstream instruction changed; regenerate and approve the target adaptation
- `local-modified`: preserve and ask whether it becomes the new target adaptation
- `conflict`: upstream and target changed; grill and produce an exact merge proposal
- `missing`: ask whether to restore or stop managing it
- `upstream-removed-retain`: retain until deletion or migration is approved
- `retained-no-update`: preserve a previously approved retained file without updating it

Present one complete plan containing:

- detected mode and pinned source commit
- isolated workspace identity
- exact root instruction diffs or contents
- selected, declined, automatically included, new, retained, and removed skills
- dependency closure
- every complete skill directory to install or update
- every Claude Code projection to create, preserve, or replace
- `skills-lock.json` effects
- `.agents/ai-assets.lock.json` effects
- all commands that will mutate files
- validation commands
- conflicts and decisions
- whether `sync-agent-assets` itself changed and a rerun will be required

Wait for explicit approval. Changed evidence, selected skills, dependencies, conflicts, source commit, or file content requires a new plan and approval.

## Phase 8: apply the approved plan

Apply only the approved changes.

1. Write the approved root instruction adaptations.
2. Install or update selected skills from `SOURCE_ROOT` with repeated `--skill NAME`, then `--agent pi`, `--agent opencode`, `--agent claude-code`, and `--yes` arguments in one command. Do not pass `--copy`; Skills CLI must keep canonical directories under `.agents/skills/` and create Claude Code's relative symlink projections.
3. Install dependencies atomically with their selected skills.
4. Do not pass removed or rejected skills to the Skills CLI.
5. Keep locally modified, deselected, or upstream-removed assets unchanged until their separate action is approved. Record every retained path and reason in `retainedFiles`.
6. Update `sync-agent-assets` last.
7. If the manager workflow, helper, catalog, or lock schema changed, stop after installation and require a fresh run before making decisions that depend on the new version.

The standard Skills CLI owns `skills-lock.json`. This skill owns `.agents/ai-assets.lock.json`. Do not hand-edit `skills-lock.json`.

## Phase 9: record managed state

Create a temporary selection JSON file outside the target repository. It must list selected skills, declined skills with reasons, managed root files, adaptation notes, and every approved retained file with its reason. Never put credentials or absolute personal paths in it.

Generate a non-mutating record plan:

```sh
node "$SYNC_AGENT_ASSETS_HELPER" record \
  --root /absolute/worktree \
  --source-root SOURCE_ROOT \
  --source-commit SOURCE_COMMIT \
  --repository SOURCE_REPOSITORY \
  --ref SOURCE_REF \
  --selection /temporary/selection.json
```

Review the selected skills, declined skills, root files, managed-file count, complete lock content, and plan ID. After approval, rebuild and apply the exact plan:

```sh
node "$SYNC_AGENT_ASSETS_HELPER" record \
  --root /absolute/worktree \
  --source-root SOURCE_ROOT \
  --source-commit SOURCE_COMMIT \
  --repository SOURCE_REPOSITORY \
  --ref SOURCE_REF \
  --selection /temporary/selection.json \
  --apply \
  --confirm \
  --plan-id PLAN_ID
```

The helper rejects structural differences between pinned source skills and installed target skills, source-commit changes, dirty source checkouts, unsafe paths, symlinked managed paths, stale plan IDs, missing files, invalid dependencies, and catalog drift.

## Phase 10: validate and report

Run all target validation required by its instructions. Also verify:

- `git diff --check`
- only approved files changed
- every skill directory matches its frontmatter name
- all selected dependencies exist
- complete skill supporting files were installed
- Pi discovers every selected project skill
- OpenCode discovers every selected project skill
- Claude Code discovers every selected project skill through an exact relative `.claude/skills/` symlink
- `CLAUDE.md` imports `AGENTS.md` before any Claude-specific instructions
- `skills-lock.json` reflects Skills CLI installation
- `.agents/ai-assets.lock.json` contains no absolute paths or secrets
- managed files report clean immediately after recording:

```sh
node "$SYNC_AGENT_ASSETS_HELPER" status --root /absolute/worktree
```

Report changed files, installed and retained skills, source commit, validation results, conflicts, unrun checks, rerun requirements, and remaining owner actions. Leave the isolated workspace and changes for the developer. Do not publish them automatically.

Clean the fetched temporary checkout only after validation and state recording:

```sh
node "$SYNC_AGENT_ASSETS_HELPER" cleanup --source-root SOURCE_ROOT
```
