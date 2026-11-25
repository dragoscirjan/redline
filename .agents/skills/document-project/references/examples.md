# Writing examples and scenario checks

Assume the reader can use standard development tools. Supply the project-specific facts needed to complete the task. The example below uses Git in a trusted checkout. Adapt the working directory and expected state to the project being documented.

## Replace shorthand with a complete task

An unclear instruction:

> Check Git and decide whether it is safe to continue.

A developer-focused how-to:

### Inspect existing changes

Prerequisites: Git and a trusted Git checkout. Run this command from the project root before starting work:

```sh
git status --short
```

With exit code 0, an empty result means Git reports no changes. Otherwise, each row shows a status and path. Inspect the existing work and establish ownership before editing; the command does not authorize a reset or removal.

If Git reports that the directory is not a repository, check the working directory. If Git is unavailable, request approved setup. Do not install tools, discard existing work, or change repository configuration merely to make this read-only check pass.

This guide supplies the runtime, working directory, exact command, expected result, and relevant recovery. It does not explain how to open a terminal.

## Do not hide technical prerequisites

An unclear command example:

```text
$ tool run --input <file>
```

A developer can read the command but cannot infer the required tool version, working directory, input format, credentials, or expected result.

For a real CLI guide:

- State project-specific installation, runtime, environment, and permission requirements.
- Identify the working directory and provide safe sample input or its exact format.
- Show a copyable command. Explain project-specific placeholders or use concrete non-sensitive sample values.
- Show the expected result, output location, and recovery for likely failures.
- Link prerequisite knowledge outside the agreed audience's standard skills. Do not re-teach basic terminal, editor, or file operations by default.

Distinguish expected results from observed execution. Mark illustrative commands and output clearly.

## Review the workflow against these situations

Use these as walkthrough scenarios, not claims that tests have passed:

| Situation | Expected behavior |
|---|---|
| A new command or UI action changes the user's workflow. | Update the affected guide and example alongside the implementation. Explain prerequisites, exact actions, success, and likely errors. |
| A public option or default changes. | Update affected examples and reference together. Remove obsolete instructions and check links. |
| The relevant page is dense or repeats itself. | Rewrite, split, or move the affected material to make the task followable. Do not append another summary or expand unrelated cleanup. |
| An internal refactor changes no reader task or public behavior. | Give a concrete no-change explanation. Do not make cosmetic documentation edits merely to show activity. |
| A new repository has no documentation site. | Propose a minimal VitePress baseline and wait for approval before creating it or installing dependencies. |
| An existing repository uses MkDocs. | Keep MkDocs and its approved environment, theme, plugins, navigation, and build workflow. Improve affected pages without requiring migration to VitePress. |
| An old repository has poor documentation or uses another site generator. | Maintain affected pages in the current site. Propose broader cleanup or any platform migration separately and preserve useful content and links. |
| A guide needs credentials, paid actions, destructive operations, or unfamiliar code. | Explain the prerequisites and risks before the action. Obtain required authorization and use safe sample data. Never expose secrets. |
| The build or example environment is unavailable. | Report the missing check and obtain an explicit owner decision before treating blocked required work as complete. Do not report a pass. |
| A site builds but instructions omit the starting files or required knowledge. | The documentation is not ready. Repair the guide; rendering is not evidence of task completion. |

## Research behind the approach

The owner-selected examples support different parts of the workflow:

- [mise getting started](https://mise.jdx.dev/getting-started.html) develops one example and shows observable results.
- [Task quick start](https://taskfile.dev/docs/getting-started) and [configuration reference](https://taskfile.dev/docs/reference/config) serve learning and lookup separately.
- [AI Hero's learning map](https://www.aihero.dev/learn) organizes material around reader questions.
- [PR-Agent's overview](https://docs.pr-agent.ai/) demonstrates useful output before advanced configuration.

These observations came from content and navigation inspection. They are not a comparative usability study.
