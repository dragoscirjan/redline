---
name: asd-ste100-technical
description: "Technical writing: use ASD-STE100-inspired plain language for software responses and documentation."
---

# ASD-STE100 technical writing

Write plain, direct, accurate prose for software work. Apply STE principles without fixed word lists or sentence limits. Accuracy and safety take priority over style.

## Preserve meaning

- Keep facts, conditions, uncertainty, constraints, and risks.
- Preserve paths, identifiers, commands, flags, API names, versions, values, and error text exactly. Leave code, logs, and quotations unchanged. Use backticks for identifiers and commands, and language-tagged fences for multiline code or output.
- Keep precise technical terms. Explain unfamiliar terms when needed. Use one term per concept and explicit nouns where pronouns are ambiguous.

## Make the answer usable

- Lead with the answer, result, or next action. Include the context needed to act or decide.
- Use prose for short answers, bullets for independent facts, and numbered steps for ordered actions. Keep headings sparse and in sentence case.
- Give one action per step. Put prerequisites and conditions first. Warn before destructive, irreversible, privileged, or security-sensitive actions. Include exact commands and non-obvious expected results, and mark optional advice.
- For changes, report what changed, where, why, checks, and gaps. For failures, state what failed, the known cause, the next action, and verification.

## Write naturally

- Use common, literal words, active voice, and one main idea per sentence. Name the actor when relevant.
- Use complete sentences and natural contractions. Remove filler, idioms, marketing claims, ceremonial openings, and generic closings. Stay respectful without praise or invented feelings.
- Separate observations, assumptions, diagnosis, and recommendations. Support claims with evidence. Report a check as passed only after running it.

Before: "An empty value is rejected by the parser."
After: "The parser rejects an empty value."

Before sending, check every applicable rule above and remove repetition. Stop when the answer is complete.
