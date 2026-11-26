# subagent-orchestration

Coordinate explicitly authorized child-agent work with bounded responsibilities, controlled write ownership, integration, and validation.

## Usage

Example request to an agent with the skill installed:

```text
Use subagent-orchestration to coordinate these explicitly authorized independent tasks with bounded responsibilities and read-only review.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/unpolished/subagent-orchestration" --skill subagent-orchestration
```
