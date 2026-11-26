# initiative

Turn an idea or research into an agreed brief that defines the problem, outcomes, scope, constraints, and success measures.

## Dependencies

Requires `grilling` to clarify the decisions needed for the brief.

## Usage

Example request to an agent with the skill installed:

```text
Use initiative to turn this idea into an agreed brief with outcomes, scope, constraints, and success measures.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill. Install the dependencies listed above separately before using this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/productivity/initiative" --skill initiative
```
