# Coding with rules

`coding-with-rules` is the language-aware entry point for code work. It declares `requires: ["coding"]` for the generic workflow, then selects ordinary Markdown references for the task's languages and file extensions.

## How it works

- Read `coding` through the declared requirement, then apply the router in [`SKILL.md`](SKILL.md).
- Load only the relevant documents under [`references/`](references/), with language guidance before extension guidance. Each extension document explicitly links its main-language prerequisite. For `.tsx`, read `ts.md` then `tsx.md`; do not assume React. Read each document once per task and stop on missing prerequisites or cycles.
- Use project evidence for ambiguous headers, interpreters, and configuration files. Do not combine contradictory Bash and POSIX rules.
- Use the base workflow and project conventions for unsupported languages, and report the coverage gap. A missing mapped reference is an error.

The 21 references contain only language/extension semantics, language-specific safety constraints, and tool defaults. Each is a regular Markdown file inside this directory, not a symlink or a link to a removed skill. They have no skill frontmatter, standalone-skill instructions, or generic workflow sections.

The generic [`coding`](../coding/SKILL.md) skill owns the shared workflow, security baseline, test and quality-gate procedure, duplicate-detector fallback, tool-installation approval, and result reporting. The references adapt the former language rules to that shared workflow rather than copying whole skill bodies. `coding` remains independently useful.

`requires` is a project convention, not a native harness loader. Project instructions resolve it; external Skills CLI commands do not install it automatically. `coding-with-rules` needs the installed `coding` instructions, not a selection manager. If either is missing, stop and ask the user to install it before continuing. Complete installation includes every reference, but the model reads only applicable files.

## Use

In Pi:

```text
/skill:coding-with-rules Implement the approved change and run the applicable project checks.
```

For a manual installation, explicitly select both skills:

```sh
npx -y skills@1.7.4 add https://github.com/dragoscirjan/ai/tree/main/.agents/skills/coding/coding --skill coding --agent pi
npx -y skills@1.7.4 add https://github.com/dragoscirjan/ai/tree/main/.agents/skills/coding/coding-with-rules --skill coding-with-rules --agent pi
```

Choose the intended harnesses rather than assuming a three-harness bundle. Review the assets and follow the target project's workspace and approval gates before installation. Claude Code uses the relative `.claude/skills/coding-with-rules` projection; no separate reference projections are needed. Reload the harness after changing its installed skill inventory.

## Migrate existing installations

The former `coding-<language>` and `coding-<extension>` skills are removed upstream, not automatically renamed or deleted in target projects.

1. Run `/sync-my-skills` and review the explicit deprecated-name list. Select `coding-with-rules` when appropriate, with its `coding` prerequisite. Unknown custom names are not automatically remapped or classified as deprecated.
2. Choose the exact legacy skills to retain or remove, including none. Review their locations, local changes, and replacement before approving the plan. A decline or missing catalog entry does not authorize deletion.
3. Install the complete router and applicable harness projections only under the current approved plan in an isolated workspace. Existing local edits remain protected; do not hand-edit either lockfile.
4. Verify only the approved legacy directories/projections were removed and reload the harness. Migration alone leaves root instructions untouched. Instruction-routing/template changes require selecting the separate bundle, reviewing project-specific drafts and policy changes, and approving the resulting plan.

The original consolidation is recorded in [#56](https://github.com/dragoscirjan/ai/issues/56). Explicit, snapshot-bound deprecated removal and reviewed lock migration are provided by [#69](https://github.com/dragoscirjan/ai/issues/69); there is no automatic prefix-based deletion.
