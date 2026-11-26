# scaffold

Create source skeletons for an approved feature and validate their structure without implementing the feature's behavior.

## Usage

Example request to an agent with the skill installed:

```text
Use scaffold to create source skeletons for this approved feature. Validate the structure and stop before implementing behavior.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/coding/scaffold" --skill scaffold
```
