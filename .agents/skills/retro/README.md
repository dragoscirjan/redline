# retro

Review a bounded period of work for evidence-backed improvements to the development process.

## Usage

Example request to an agent with the skill installed:

```text
Use retro to review this completed work period and propose evidence-backed process improvements.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/productivity/retro" --skill retro
```
