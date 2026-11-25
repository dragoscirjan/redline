# debloat

Prevent unnecessary complexity and simplify code, configuration, or dependencies while preserving required behavior, contracts, security, and operational needs.

## Usage

Example request to an agent with the skill installed:

```text
Use debloat to identify unnecessary complexity in this component and propose a simpler design that preserves its contracts.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/coding/debloat" --skill debloat
```
