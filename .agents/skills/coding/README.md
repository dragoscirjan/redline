# coding

Design, implement, refactor, review, and test code under project conventions, with security and behavior checks appropriate to the change.

## Usage

Example request to an agent with the skill installed:

```text
Use coding to implement this approved change under the project's conventions and report the checks and remaining gaps.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/coding/coding" --skill coding
```
