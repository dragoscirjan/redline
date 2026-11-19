# Validation

Read before validating, committing, pushing, or publishing. Use configured checks
for the changed files and behavior. Do not invent commands or thresholds.
Use Redline's configured tools and report checks that could not run. Do not
install or reconfigure tools, change installer policy, or weaken a gate without
explicit owner approval.

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

- Review status and the complete diff. Keep changes within approved scope and preserve unrelated work.
- Check documentation, examples, paths, and links against implemented behavior.
- Report each check as passed, failed, not run, or unsupported. An unexecuted check has not passed.
- Run `git diff --check` and inspect `git status`.
- Check affected Markdown references, command examples, and headings.
- State failures, unrun checks, and remaining risks without claiming success.

Tests use temporary directories and repositories and must not mutate the source
checkout. Network tests beyond loopback and live-harness tests remain opt-in.
Never execute untrusted pull request code, scripts, builds, tests, or installers
during a review.

## Documentation

Use `DOCUMENTATION.md` for the approved engine, configuration, sources, and canonical commands.
Redline's existing engine is VitePress. Preserve its navigation and generated-output boundaries. The existing full gate
builds the site; no separate link-checking or usability-test tool is configured.

Check affected relative links, headings, navigation entries, and examples
against source evidence. Walk changed instructions from their stated starting
point and report missing prerequisites or steps. Execute examples only when
authorized and safe. Distinguish a site build, executed examples, an agent
walkthrough, and actual user testing; none substitutes for the others.

## Agent assets

When instructions or project skills change:

- Confirm the exact instruction proposal was approved before mutation.
- Check scope, phase routes, references, and required targets for missing files, conflicts, duplication, and ambiguity.
- Check requirement load order, missing targets, and cycles using the project's actual dependency convention.
- Verify selected skill metadata and complete support files.
- Preserve safety rules, approval gates, validation requirements, and publication authority. Record approval for consequential instruction changes.
- Distinguish static reference checks from observed live harness loading.
- Preserve security boundaries and owner authority unless a separately identified change was explicitly approved.
- Match every selected skill directory to its frontmatter name and description; verify selected dependency closure.
- Compare synchronized files with the approved pinned source or exact adaptation.
- Verify Pi and OpenCode discovery from `.agents/skills/`; distinguish static
  discovery evidence from a runtime harness check.
- Verify each selected Claude projection is exactly
  `.claude/skills/<name> -> ../../.agents/skills/<name>`, and verify runtime
  discovery when available.
- Confirm `CLAUDE.md` imports `@AGENTS.md` before Claude-specific instructions.
- Keep `skills-lock.json` Skills CLI-owned. Check its pinned, portable provenance.
  When synchronization does not invoke Skills CLI, report that this file retains
  legacy installation receipts; do not hand-edit it or treat it as current manager state.
- Generate `.agents/ai-assets.lock.json` only through the personal
  `sync-my-skills` helper's approved plan and apply workflow. Check pinned catalog
  and source revisions, selected and declined skills, removals, adaptations,
  reviewed instructions, managed files, and projections. Read legacy records
  without treating them as approval to adopt or overwrite instructions.
- Check managed lock data for absolute paths, temporary paths, and secrets.
- Run the personal synchronization helper's `status --root <worktree>` command
  after applying and require clean managed files and projections. Verify flat
  `.agents/skills/<name>/` installation paths, declared instruction requirements,
  legal notices, and omission of provider metadata such as `agents/openai.yaml`.
- Record conflicts, retained assets, rerun requirements, and unverified discovery.

The existing Vitest configuration selects `test/**/*.test.ts`. Imported skill
support tests are not automatically Redline project tests. Review their network
effects and repository assumptions before proposing a separate test run.
The former synchronization-manager support suite invoked Skills CLI and
asserted upstream-specific documentation; its removal does not authorize
running replacement personal-manager tests as part of Redline's ordinary gate.
Report separate support suites as not run unless an applicable test plan is approved.

## Completion

Account for required documentation and check results before reporting completion.
If a required check or documentation task is blocked, report the gap and obtain
an explicit owner decision before calling the work complete. Obtain approval before installing or reconfiguring tools, suppressing failures,
lowering thresholds, or replacing a missing gate with a no-op. A passing build
does not prove example correctness, reader comprehension, live service behavior,
or production compatibility.

## Publication report

Before pushing or opening a pull request, report changed files, checks that
passed or failed, checks that did not run and why, and remaining owner actions.
Report the active branch and absolute worktree path. Validation does not grant
permission to commit, push, publish, merge, or release.

Report changed files, check results, gaps, and remaining owner actions. If a
required check is blocked, obtain an explicit owner decision before calling the
work complete. Validation does not authorize publication.
