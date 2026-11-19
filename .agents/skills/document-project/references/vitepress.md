# VitePress setup and checks

Use this reference for approved site setup, migration, configuration, and build work. It is guidance, not permission to install packages, initialize a site, change hosting, or deploy.

## Inspect before proposing a baseline

Read the current documentation, package manifests, lockfiles, scripts, navigation, and hosting configuration. Use the project's package manager, versions, source directory, and conventions. Check the Node.js requirements of the selected VitePress version rather than assuming a version.

If there is no site, propose the smallest useful baseline:

- The reader and their first useful task.
- The documentation location and a short page outline.
- Required dependencies and development, build, and preview commands.
- Navigation, intended URL base, and how existing links will be preserved.
- What is excluded, what checks can run, and what needs owner approval.

Wait for approval before creating the baseline. Do not create a JavaScript toolchain merely because the project has no package manifest. Explain that addition and obtain approval first. A documentation site does not require custom components, plugins, analytics, or deployment automation by default.

## Build a small approved site

VitePress commonly uses a documentation source directory such as `docs/`, with configuration under `docs/.vitepress/`. Adapt this to the approved project layout; do not overwrite an existing configuration.

Start with a first-use page that reaches a visible result. Add only the task guides, reference, and explanations needed to support it. Set navigation and sidebar links to those pages. Keep contributor and release instructions separate from the user's starting point.

For a project using npm and an approved `docs/` source directory, these are example package scripts:

```json
{
  "scripts": {
    "docs:dev": "vitepress dev docs",
    "docs:build": "vitepress build docs",
    "docs:preview": "vitepress preview docs"
  }
}
```

Merge approved scripts into the existing manifest. Preserve unrelated scripts and use the equivalent commands for the project's actual package manager. Do not copy the example into a different project without adapting it.

Tell the maintainer how to start the local site and use the URL printed by the development server. Do not assume the reader knows the command's working directory or that a particular port is available.

## Preserve existing documentation

For a migration, inventory entry points, pages, assets, anchors, and incoming links. Identify what remains correct, what needs rewriting, and what becomes obsolete. Obtain approval for the migration and its link-preservation approach before replacing the site.

During feature work without migration approval, improve affected documentation in its existing system. Record broader problems for separately approved cleanup. Do not create a competing site or make every feature depend on rewriting the whole documentation set.

## Check the result

- Run the project's approved production build. Use its existing commands rather than installing a tool merely to check the site.
- Fix broken internal links. Do not disable dead-link checking to make the build pass. Run available checks for links the build does not cover.
- Check navigation, sidebar entries, page titles, fragments, downloads, and images. Verify that readers can reach both the first-use guide and the next useful page.
- Match the `base` configuration to the approved deployment path. A site under a subdirectory needs its links and assets checked in that context; do not guess a hosting URL.
- Use the approved preview when available to inspect the built site. Verify presentation separately from reading the Markdown source.
- Test documented commands and UI actions only where authorized. Mark unexecuted examples and unavailable environments in the handoff.
- Check the guide's starting state, success conditions, and recovery steps independently of the build. Do not claim human usability from rendering alone.

Report deployment as a separate action requiring its applicable authorization.

## Sources

Checked against official VitePress documentation through Context7 during implementation. Follow the selected project's version if its behavior differs.

- [Getting started](https://vitepress.dev/guide/getting-started)
- [Site configuration](https://vitepress.dev/reference/site-config)
- [Sidebar](https://vitepress.dev/reference/default-theme-sidebar)
- [Deployment and base paths](https://vitepress.dev/guide/deploy)
