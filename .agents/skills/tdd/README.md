# tdd

Build behavior in small test-first slices, with tests that fail before implementation and pass afterward.

## Usage

Example request to an agent with the skill installed:

```text
Use tdd to implement this approved behavior in small test-first slices, proving each test fails before its implementation passes.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/coding/tdd" --skill tdd
```

## Origin

Adapted from [tdd](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/tdd) at revision `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`.
