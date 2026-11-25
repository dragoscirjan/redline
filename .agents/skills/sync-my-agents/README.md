# sync-my-agents

Review AGENTS.md and the instruction documents it references, identify necessary changes, and apply only approved updates.

## Usage

Example request to an agent with the skill installed:

```text
Use sync-my-agents to review AGENTS.md and its referenced documents against this project. Show exact necessary diffs before editing.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/agentic-work/sync-my-agents" --skill sync-my-agents
```
