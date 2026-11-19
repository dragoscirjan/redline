# MkDocs maintenance and checks

Use this reference for existing MkDocs sites and approved MkDocs setup or configuration work. Keep a working MkDocs site on MkDocs unless a platform change is explicitly approved. The reader-focused workflow in the main skill applies without migration.

This reference does not authorize package installation, site initialization, theme changes, migration, or deployment.

## Inspect the existing project

Find the actual MkDocs configuration, commonly `mkdocs.yml`, and any explicit configuration path used by project scripts or CI. Inspect:

- The installed MkDocs version, Python environment, dependency manifests, lockfiles, and approved commands.
- `docs_dir`, `site_dir`, `nav`, and any inherited or additional configuration.
- The current theme, plugins, Markdown extensions, hooks, custom templates, and assets.
- `site_url`, `use_directory_urls`, link conventions, and hosting paths.
- Existing validation settings and link-checking tools.

Inspect configuration as data first. Building the site can load Python plugins, hooks, and custom configuration behavior. Do not execute unfamiliar configuration or install dependencies merely to detect the platform. Use an approved, trusted environment for actual builds.

Preserve the project's environment and commands. Do not replace its dependency manager, upgrade MkDocs, add Material for MkDocs, or change its theme merely to improve prose. Material is an optional theme, not a requirement of this skill.

## Improve the existing reader path

Read affected pages before editing. Keep their correct content and apply the main skill's task-based writing and project-specific prerequisites.

Update `nav` when affected pages are added, moved, renamed, or removed. Navigation paths refer to documentation source files relative to `docs_dir`. If the site uses automatic navigation or a navigation plugin, follow that approach instead of replacing it.

Check Markdown links, heading fragments, images, downloads, and theme-specific features after restructuring. Preserve existing URLs where possible; obtain approval for broader URL changes and use the project's approved redirect or link-update approach.

Use syntax supported by the project's Markdown extensions and theme. Do not paste VitePress-specific components or directives into MkDocs pages.

Preserve plugin and extension configuration when editing. Replacing the `plugins` list can remove default or existing plugins, including search. Do not replace a working list with a generic template.

## Build and review safely

Use the approved project command in its existing Python environment. A project wrapper or CI command takes precedence over these examples.

For an environment that already provides MkDocs, these commands are examples to run from the directory containing the intended configuration:

```sh
mkdocs serve
```

Use the local URL printed by the server to review the site. Do not assume that a particular port is available.

For a production build with warnings treated as errors, use the project's strict build command where supported and approved:

```sh
mkdocs build --strict
```

Use the project's existing explicit configuration path when it differs from the default. Do not install MkDocs to make these examples runnable without approval. Do not invoke deployment commands to validate a local change.

- Check the build's errors and warnings. Fix relevant problems rather than disabling strict mode or suppressing warnings to obtain a pass.
- Review navigation, page titles, Markdown links, fragments, downloads, and images in the built site.
- Check links and assets under the approved hosting path. Preserve the intended `site_url` and `use_directory_urls` behavior instead of guessing a new URL layout.
- Inspect the installed version's validation capabilities. Older versions and different configurations report different link and anchor problems. Do not copy newer validation keys into an older project or silently upgrade it.
- Use available project link checks for what the build does not cover. A successful strict build does not prove that every external URL or reader task works.
- Walk through the guide from its stated starting point. Verify prerequisites, exact actions, observable results, and recovery separately from rendering.
- Report the build, link checks, executed examples, agent walkthrough, and actual user testing separately. If required checks are blocked, obtain an explicit owner decision before treating the work as complete.

## Sources

Checked against official MkDocs documentation through Context7 during implementation. Use the documentation for the project's installed version when behavior differs.

- [Getting started and local preview](https://www.mkdocs.org/getting-started/)
- [Configuration, navigation, plugins, and validation](https://www.mkdocs.org/user-guide/configuration/)
- [Command-line interface and strict builds](https://www.mkdocs.org/user-guide/cli/)
- [Writing documentation and links](https://www.mkdocs.org/user-guide/writing-your-docs/)
