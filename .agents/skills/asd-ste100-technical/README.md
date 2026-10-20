# ASD-STE100 technical writing

`asd-ste100-technical` is a portable Agent Skill for developer-facing prose. It teaches an agent to use direct, natural language without removing technical detail.

The skill applies to chat responses, coding explanations, plans, reviews, documentation, instructions, error reports, and change summaries.

## Origins

The skill combines ideas from three sources.

### Issue 1 and Simplified Technical English

[Issue 1](https://github.com/dragoscirjan/ai/issues/1) proposed a skill based on [ASD-STE100](https://www.asd-ste100.org/). The issue highlighted these useful principles:

- Use common words in their literal meaning.
- Prefer active voice.
- Keep sentences short.
- Put one instruction in each sentence.
- Remove ambiguous pronouns, idioms, slang, and metaphors.

The issue also noted that strict Simplified Technical English can sound robotic. A strict word list can make software explanations less accurate. This skill therefore adapts those principles instead of claiming ASD-STE100 compliance.

### The `unslop` skill

The repository's [`unslop`](../unslop/SKILL.md) skill inspired the direct rule-based format and the focus on natural language. `unslop` removes common AI writing patterns from an existing draft.

`asd-ste100-technical` has a different job. It guides the agent while the agent writes a technical response. The new skill is original work. It does not copy or modify the vendored `unslop` source.

The two skills can work together:

1. Use `asd-ste100-technical` to draft an accurate response.
2. Use `unslop` to remove any remaining AI writing patterns.

Technical accuracy and safety take priority if the rules conflict.

### Pi response guidance

Pi can add response guidance through harness extensions. Other coding harnesses do not always support the same extension model.

This skill moves the guidance into the portable `.agents/skills/` format. Pi and OpenCode can discover the same skill from the repository. No Pi extension code is included or required.

## Adaptations for technical work

General plain-language rules are not enough for software tasks. The skill adds the following requirements.

### Preserve exact technical text

The agent must keep file paths, identifiers, commands, flags, API names, versions, logs, and error messages exact. Prose rules do not apply inside code, command output, logs, or quotations.

The skill also prevents false simplification. An agent must keep a precise technical term when a common word would change the meaning. The agent can define the term when the audience may not know it.

### Report evidence honestly

The agent must separate observations, diagnosis, assumptions, and recommendations. It must not claim that a command, build, or test passed unless the check ran successfully.

Failure reports identify what failed, the direct cause, the next action, and the verification step when those details are known.

### Make coding instructions usable

Ordered procedures use one action per step. They include exact paths, commands, symbols, prerequisites, and expected results when needed.

The skill requires warnings before destructive, irreversible, privileged, or security-sensitive actions.

### Match the response format to the task

Short answers stay as prose. Independent facts use bullets. Procedures use numbered steps only when order matters.

The skill avoids forcing every response into a large template. It also avoids introductions, summaries, and closing invitations when the answer does not need them.

### Keep a natural tone

The skill allows contractions and normal sentence-length variation. It removes praise, ceremonial openings, generic chatbot closings, and casual filler.

The result should sound like a direct and respectful teammate, not a policy document or a simulated personality.

### Check the draft before sending

The final check covers clarity, pronoun references, exact technical values, assumptions, warnings, unnecessary sentences, and tone. The agent performs the check silently.

## Invocation

The frontmatter description allows a compatible harness to select the skill for developer-facing writing.

Pi users can load it explicitly with:

```text
/skill:asd-ste100-technical
```

A project can also require the skill through its agent instructions when every response must follow these rules.

## Files

- [`SKILL.md`](SKILL.md) contains the instructions loaded by an agent.
- `README.md` documents the design, sources, and technical adaptations.

Keep the directory name and the `name` field in `SKILL.md` set to `asd-ste100-technical`. This match is required for portable Agent Skills discovery.
