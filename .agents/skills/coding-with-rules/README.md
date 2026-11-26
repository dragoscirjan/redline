# coding-with-rules

Select coding guidance for the languages and file extensions involved in a task.

## Dependencies

Requires `coding` for the base coding workflow.

## Usage

Example request to an agent with the skill installed:

```text
Use coding-with-rules to implement this approved change using the relevant language and file-extension guidance.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill. Install the dependencies listed above separately before using this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/coding/coding-with-rules" --skill coding-with-rules
```
