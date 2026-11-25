# research

Investigate a question, compare alternatives, or assess feasibility. Report evidence, sources, uncertainty, and limits.

## Dependencies

Requires `grilling` to clarify the research question and its constraints.

## Usage

Example request to an agent with the skill installed:

```text
Use research to compare these alternatives against our constraints. Separate verified evidence from assumptions and do not implement anything.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill. Install the dependencies listed above separately before using this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/productivity/research" --skill research
```
