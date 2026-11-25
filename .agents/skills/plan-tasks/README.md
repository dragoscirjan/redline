# plan-tasks

Divide an agreed specification or clear scope into bounded, verifiable tasks with explicit dependencies and completion evidence.

## Usage

Example request to an agent with the skill installed:

```text
Use plan-tasks to divide this agreed specification into bounded tasks with dependencies and verifiable completion criteria.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/productivity/plan-tasks" --skill plan-tasks
```
