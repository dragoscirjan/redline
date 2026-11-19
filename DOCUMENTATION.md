# Documentation

Assess documentation impact during implementation. Update affected documentation
in the same change, or give a concrete reason no update is needed.

## Required guidance

- For implementation and documentation work, read and follow `.agents/skills/document-project/SKILL.md`.
- Before drafting or revising documentation, also read and follow `.agents/skills/asd-ste100-technical/SKILL.md` and `.agents/skills/unslop/SKILL.md`.
- If required guidance or prerequisites are missing, stop the affected phase and report the gap. Do not skip, recreate, or install them without approval.

## Audience and reader tasks

Write for developers who know Git, terminals, and standard development tools but
are new to Redline. Help them install Redline, connect a model, review local Git
changes or GitHub pull requests, read findings, troubleshoot failures, and
contribute safely. Explain project-specific prerequisites and observable
results. Keep architecture and release details out of the first-review path.

## Sources and ownership

- `README.md` introduces the project and links to first-use and contributor guidance.
- `docs/` holds product guides, reference pages, architecture, benchmarks, and maintenance documentation.
- `docs/get-started/` contains the install, configuration, and first-review path.
- `docs/.vitepress/config.ts` owns VitePress navigation, sidebar links, and deployment-base selection through `DOCS_BASE`.
- `AGENTS.md`, `CONTRIBUTING.md`, and `VALIDATION.md` govern agent workflow, contribution procedures, and checks. Preserve their authority when documenting commands.
- `docs/.vitepress/dist/` and `docs/.vitepress/cache/` are generated output, not authored documentation. Rebuild them rather than editing them.

Keep documentation with its implementation. Register new product pages in
`docs/.vitepress/config.ts`. Keep the GitHub Actions and CLI references aligned
with their actual interfaces, and label Forgejo/Gitea and other planned work as
planned rather than implemented.

## Engine selection

VitePress is the approved existing engine. Its configuration is
`docs/.vitepress/config.ts`; `package.json`, `pnpm-lock.yaml`, and `mise.toml`
define the toolchain and commands. Do not initialize another documentation site.

- Keep an existing approved MkDocs or VitePress site, including its configuration, theme, plugins, and commands.
- Preserve any other existing documentation system unless an explicit migration is approved.
- If MkDocs and VitePress both exist, or the canonical source is unclear, ask the owner before choosing a source, creating a competing site, or changing engine configuration.
- If no site is approved, maintain existing Markdown. When a site is needed, propose VitePress by default. The owner may choose MkDocs. Obtain baseline approval before setup.
- For received built documentation, generate in the owning repository. Leave generated files unedited and do not initialize a source site here.
- Choose from approved configuration or an owner decision, never solely from programming language.
- Site setup, dependencies, theme changes, migrations, and deployment require their applicable approval.

## Writing and maintenance

- Document supported behavior. Label planned and deferred work.
- Explain project-specific prerequisites, actions, results, and limits. Assume the agreed audience's standard skills.
- Update affected guides, examples, reference pages, and navigation with user-visible changes.
- Refactor unclear affected material instead of appending repetition. Keep unrelated cleanup and site rewrites separately approved.
- Write plainly and concretely. Preserve exact identifiers, security warnings, required input groups, and the distinction between CLI, Docker, and isolated Actions execution.
- Use public configuration schemas, source interfaces, and safe examples as evidence. Never include real credentials or private user configuration.
- Link to canonical configuration and release references rather than maintaining competing command or policy lists.
- Diagram skills such as Archify and Excalidraw are available when useful. Their installation does not approve generated-site changes, external publication, or application toolchain changes.

## Canonical commands

Run from the approved Redline worktree root with the tools and locked
dependencies from `CONTRIBUTING.md` available. The pinned tool versions are in
`mise.toml`. Prefer the existing Mise tasks:

| Task | Command | Result |
|---|---|---|
| Edit with a local development server | `mise run docs:serve` | Runs `pnpm run serve`, which starts VitePress for `docs/`. |
| Build the site | `mise run docs` | Runs `pnpm run docs` and generates `docs/.vitepress/dist/`. |
| Preview a built site | `mise run docs:preview` | Runs `pnpm run docs:preview`; build first. |

Local builds use the default `/` base. The existing documentation publication
workflow supplies `DOCS_BASE=/projects/redline/` for its deployment build. Keep
that workflow's ownership and approval rules; local validation is not deployment.
No documentation-only link checker or usability-test command is configured.

Keep the approved toolchain. Do not replace the package manager, Python
environment, theme, or plugins merely to write documentation. Deployment is not
local validation.

## Completion

Run documentation checks from `VALIDATION.md`. Report builds, executed examples,
agent walkthroughs, and actual user testing separately. Rendering does not prove
task usability.

Required documentation is part of completion. If required documentation or
checks are blocked, report the gap and obtain an explicit owner decision before
calling the work complete.
