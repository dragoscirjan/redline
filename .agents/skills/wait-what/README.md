# wait-what

Re-pitch an unclear answer with missing context, plain technical language, and consistent vocabulary. Prefer the project's glossary; use the bundled default when none is available. No required skills.

## Usage

Example request to an agent with the skill installed:

```text
Use wait-what to explain your last answer again with more context and simpler language.
```

## Install

Run from the target project with Node.js 22.20 or newer, Git, and npm available. Replace the value of `ref` with a published tag or commit that contains this skill.

```sh
ref="<published-tag-or-commit>"
npx -y skills@1.7.4 add "https://github.com/dragoscirjan/ai/tree/$ref/.agents/skills/productivity/wait-what" --skill wait-what
```

## Origin

Adapted from [wait-what](https://github.com/mattpocock/skills/tree/d80fa0f4ebe0c5714af0adf8670336065233ecc6/skills/productivity/wait-what) at revision `d80fa0f4ebe0c5714af0adf8670336065233ecc6`. The default glossary is adapted from [the upstream glossary](https://github.com/mattpocock/skills/blob/d80fa0f4ebe0c5714af0adf8670336065233ecc6/GLOSSARY.md) at the same revision, with repository-specific setup and skill references removed.
