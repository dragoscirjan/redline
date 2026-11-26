# specify

Turn agreed decisions into a compact specification with observable behavior, acceptance criteria, constraints, and test boundaries.

## Dependencies

Requires `grilling` to resolve decisions needed for the specification.

## Usage

Example request to an agent with the skill installed:

```text
Use specify to turn these agreed decisions into a compact specification with observable behavior and acceptance criteria.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill. Install the dependencies listed above separately before using this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/productivity/specify" --skill specify
```
