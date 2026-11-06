# Validation

Read this document before validating, committing, pushing, or publishing a
repository change. Use Redline's configured tools and report checks that could
not run. Do not install or reconfigure tools, change installer policy, or weaken
a gate without explicit owner approval.

## Required project gate

```bash
mise run validate
```

The gate runs these tasks in order and stops on the first failure:

1. `mise run typecheck` checks TypeScript without emitting files.
2. `mise run test` runs the vitest and bats suites against TypeScript source.
   Node/Bun compatibility is enforced by no-emit type checking and the
   source-runtime integration matrix.
3. `mise run docs` builds the VitePress site.

Formatting, linting, duplication analysis, dependency vulnerability audits,
recorded review-quality evaluation, and Git hooks are not implemented gates.
Do not claim they passed or add no-op replacements. Adding them requires a
separate reviewed change.

A passing local gate does not prove live model quality, forge comment
publication, or production action compatibility.

Dependency setup follows `CONTRIBUTING.md`. If installation is approved, use
`pnpm install --frozen-lockfile` and preserve `pnpm-workspace.yaml` installer,
override, and minimum-release-age policy. Stop and report missing tools rather
than installing or reconfiguring them without approval.

## Every change

- Run `git diff --check`.
- Review the complete diff and `git status`; only approved task files may change.
- Check affected Markdown links, references, command examples, and headings.
- Report each relevant check as passed, failed, not run, or unsupported.
- State failures, unrun checks, and remaining risks without claiming success.

Tests use temporary directories and repositories and must not mutate the source
checkout. Network tests beyond loopback and live-harness tests remain opt-in.
Never execute untrusted pull request code, scripts, builds, tests, or installers
during a review.

## Agent assets

When instructions or project skills change:

- Confirm the exact instruction proposal was approved before mutation.
- Check routes, dependencies, and phase handoffs for missing targets, conflicts,
  duplication, ambiguity, and cycles.
- Preserve security boundaries, workflow gates, validation requirements, and
  owner authority unless a separately identified change was explicitly approved.
- Match every selected skill directory to its frontmatter name and description.
- Verify complete supporting directories and selected dependency closure.
- Compare synchronized files with the approved pinned source or exact adaptation.
- Verify Pi and OpenCode discovery from `.agents/skills/`; distinguish static
  discovery evidence from a runtime harness check.
- Verify each selected Claude projection is exactly
  `.claude/skills/<name> -> ../../.agents/skills/<name>`, and verify runtime
  discovery when available.
- Confirm `CLAUDE.md` imports `@AGENTS.md` before Claude-specific instructions.
- Keep `skills-lock.json` Skills CLI-owned. Check its pinned, portable provenance.
- Generate `.agents/ai-assets.lock.json` only through the synchronization helper's
  approved record plan. Check repository/ref/commit, selected and declined skills,
  adaptations, managed files, and projections.
- Check managed lock data for absolute paths, temporary paths, and secrets.
- Run the synchronization helper's `status --root <worktree>` command after
  recording and require clean managed files and projections.
- Record conflicts, retained assets, rerun requirements, and unverified discovery.

The existing Vitest configuration selects `test/**/*.test.ts`. Imported skill
support tests are not automatically Redline project tests. Review their network
effects and repository assumptions before proposing a separate test run.
In particular, the imported synchronization-manager suite invokes Skills CLI
and asserts upstream-specific documentation. Do not run or wire it into the
ordinary gate automatically. Report it as not run unless a separate applicable
test plan is approved.

## Publication report

Before pushing or opening a pull request, report changed files, checks that
passed or failed, checks that did not run and why, and remaining owner actions.
Report the active branch and absolute worktree path. Validation does not grant
permission to commit, push, publish, merge, or release.
