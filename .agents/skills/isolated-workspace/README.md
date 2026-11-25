# isolated-workspace

Prepare a dedicated task branch or bookmark in the current checkout or an isolated Git or Jujutsu workspace while preserving existing work.

## Usage

Example request to an agent with the skill installed:

```text
Use isolated-workspace to prepare this approved task on a dedicated branch or bookmark while preserving existing work.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/utility/isolated-workspace" --skill isolated-workspace
```
