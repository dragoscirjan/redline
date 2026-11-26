# instruction-maintenance

Identify instruction drift, routing problems, and stale skill metadata. Propose exact changes for human approval before modifying instructions.

## Usage

Example request to an agent with the skill installed:

```text
Use instruction-maintenance to audit these instruction routes and propose exact necessary changes. Do not edit instructions before approval.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/unpolished/instruction-maintenance" --skill instruction-maintenance
```
