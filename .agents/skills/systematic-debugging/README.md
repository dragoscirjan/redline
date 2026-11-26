# systematic-debugging

Diagnose failures and unexpected behavior through evidence, root-cause tracing, and single-hypothesis experiments before proposing fixes.

## Usage

Example request to an agent with the skill installed:

```text
Use systematic-debugging to investigate this failure. Gather evidence and test a root-cause hypothesis before proposing a fix.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/coding/systematic-debugging" --skill systematic-debugging
```

## Origin

Inspired by [Superpowers' systematic-debugging skill](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging).
