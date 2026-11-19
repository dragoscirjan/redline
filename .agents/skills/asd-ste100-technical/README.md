# ASD-STE100 technical writing

`asd-ste100-technical` guides developer-facing responses, explanations, plans, reviews, documentation, instructions, and error reports. It uses plain language without losing technical meaning.

## Approach

This is a software-focused adaptation, not a claim of ASD-STE100 compliance. It keeps active voice, clear terms, and actionable steps without fixed word lists or sentence limits. Accuracy, uncertainty, exact technical text, and safety warnings take priority over brevity.

[`SKILL.md`](SKILL.md) is the complete, standalone instruction set. No scripts, dependencies, or harness extensions are needed.

## Use

Load the skill through your harness. In Pi:

```text
/skill:asd-ste100-technical
```

A project can select it through agent instructions. Keep the directory name and frontmatter `name` as `asd-ste100-technical`.
