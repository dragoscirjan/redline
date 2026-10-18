# Validate agent skills and instructions

Read this document before validating, committing, or pushing changes to
`.agents/skills/`, `AGENTS.md`, `CONTRIBUTING.md`, or this file. These are
contributor checks, not instructions for Redline's tool-disabled pull-request
review harness. For every change, `CONTRIBUTING.md` still requires
`mise run validate` before pushing. Do not install tools or add gates to
satisfy this checklist.

## Every skill or instruction change

- Run `git diff --check` and, for staged files, `git diff --cached --check`.
  Review `git status` and the complete changed content, including new files.
- Confirm that every changed file belongs to the approved issue or task.
- Check headings, relative links, paths, code fences, and command examples.
  State which checks passed, failed, or could not run; never call an
  unexecuted check a pass.

## Skill changes

- Check that each changed `SKILL.md` has a valid `name` and `description` in
  its frontmatter, that its directory matches its declared name, and that
  its description says when to load it.
- Check local references and advertised dependencies. Resolve all required
  sibling skills from `.agents/skills/` and identify missing or circular
  dependencies before relying on a skill.
- Check flat discovery from `.agents/skills/` in Pi and OpenCode where the
  runtimes are available. If runtime discovery cannot be tested, check the
  directory layout and metadata statically and report the runtime gap.
- Check that harness-specific instructions are identified as such. Skills
  for contributors do not alter Redline's fixed PR-review prompts, disabled
  tools, or security boundaries.

## Coding-family changes

When changing `coding` or `coding-*` skills, verify the load order: generic
`coding` before a language skill, then the language skill before its
extension skill. If a required skill is missing or a cycle appears, stop
and report it rather than silently skipping a layer. Keep extension skills
focused on their differences. Redline's configured tools and
`mise run validate` take precedence; do not import ai's fallback toolchain,
install packages, or create new formatting, linting, duplication, audit, or
scanning gates through a skill.

## Workspace-skill changes

When changing `isolated-workspace` or `cleanup-workspaces`, exercise the Git
procedure in a disposable repository, including relevant safety stops for
dirty or unrelated work and a successful path. Confirm that `AGENTS.md`,
`CONTRIBUTING.md`, and the skills agree on the issue, branch, and directory
mapping. Do not test by removing a real contributor worktree. Redline uses
Git only; ai's Jujutsu and memory-derived workspace instructions do not apply.

## Instruction changes

- Confirm that the owner approved the exact affected files and rule changes;
  if scope or protected rules changed, obtain a revised approval first.
- Check routing triggers, required dependencies, and later-phase handoffs for
  missing targets, conflicts, duplication, and cycles. Keep detailed
  procedures out of startup instructions unless they are required there.
- Preserve Redline's issue intake, worktree isolation, `mise run validate`
  gate, review-harness security boundaries, and owner merge authority unless
  a change to each rule was separately identified and approved.
- Check that the worktree instructions remain in `CONTRIBUTING.md`, and that
  this document supplements rather than duplicates its code validation gate.

Before pushing, report the checks that ran, those that did not run and why,
and any remaining risks. Do not treat a green CI check as proof of live model
review quality or permission to merge.
