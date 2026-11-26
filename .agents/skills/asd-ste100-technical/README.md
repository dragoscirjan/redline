# asd-ste100-technical

Write software documentation and responses in plain language inspired by ASD-STE100 while preserving technical meaning, conditions, and uncertainty.

## Usage

Example request to an agent with the skill installed:

```text
Use asd-ste100-technical to rewrite this API guide in plain language while preserving its conditions, warnings, and exact identifiers.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/documentation/asd-ste100-technical" --skill asd-ste100-technical
```
