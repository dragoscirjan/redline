# document-project

Maintain task-based developer documentation alongside implementation, with clear prerequisites, examples, expected results, and validation limits.

## Usage

Example request to an agent with the skill installed:

```text
Use document-project to update the documentation for this approved behavior change, including the reader's starting point and expected result.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/documentation/document-project" --skill document-project
```
