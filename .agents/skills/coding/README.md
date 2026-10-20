# Coding

`coding` is the generic base skill for code changes in any language. It combines project-first design, contextual engineering principles, risk-based security, behavior-focused testing, and explicit quality-gate reporting.

The skill avoids clean-code dogma. KISS, YAGNI, DRY, SOLID, design patterns, and functional techniques are useful only when they make the current code easier to understand, change, test, or secure.

## Sources

The security guidance uses these references:

- [OWASP Developer Guide](https://devguide.owasp.org/)
- [OWASP Developer Guide secure coding checklist](https://devguide.owasp.org/en/04-design/02-web-app-checklist/)
- [CWE Top 25 Most Dangerous Software Weaknesses](https://cwe.mitre.org/top25/)

The [OWASP Secure Coding Practices Quick Reference Guide](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/) is archived. OWASP migrated and updated its checklist content in the Developer Guide, so the skill uses the current Developer Guide sources above.

The duplicate-code fallback is [jscpd](https://jscpd.dev/), which supports more than 200 languages. Existing project tooling still takes precedence.

These sources guide risk analysis. They are not copied into the skill and do not replace project-specific requirements.

## Dependency contract

All coding skills are sibling directories directly under `.agents/skills/`. Do not nest one skill inside another.

A future language skill must:

1. Declare in `compatibility` that it requires `coding`.
2. Locate `coding` through the harness's advertised skill names and paths.
3. Read `coding/SKILL.md` before applying language-specific instructions unless it is already loaded.
4. Stop and ask the human to install or expose `coding` when it is unavailable.
5. Never install the dependency automatically.

A future extension skill follows the same rules for both `coding` and its language skill. Load instructions in this order:

1. Generic `coding` guidance.
2. Language guidance.
3. Extension guidance.

The more specific skill overrides only an explicit conflict. Dependencies must not form a cycle.

Do not rely on a harness-specific Skill tool. Use the skill metadata and paths that the active harness advertises. Pi and OpenCode must discover every skill as a flat sibling.

## Quality gates

The generic skill defines gate categories and reporting. Language skills select project-first fallback tools for those categories.

Every language skill must account for:

- formatting
- compilation or type checking when applicable
- linting or static analysis
- focused and broader tests
- jscpd as the fallback duplicate detector
- security analysis
- dependency or package auditing

A language skill may mark a category unsupported when its ecosystem has no mature option. It must explain that result and must not claim the gate passed.

Numeric thresholds come from project configuration. The skill family does not define universal coverage, duplication, or complexity numbers.

## Invocation

Pi exposes the skill through its [`/skill:name` command](https://pi.dev/docs/latest/skills):

```text
/skill:coding Implement the approved change and run the applicable project gates.
```

OpenCode exposes this skill as `/coding` because its frontmatter sets `metadata.opencode/slash` to `"true"`; see the [OpenCode skill documentation](https://opencode.ai/docs/skills):

```text
/coding Implement the approved change and run the applicable project gates.
```

Both harnesses also advertise the skill for automatic model selection. For language-specific work, load the matching `coding-*` skill when available.

## Files

- [`SKILL.md`](SKILL.md) contains the coding workflow.
- `README.md` explains the design, sources, and dependency contract.

Keep the directory name and the `name` field in `SKILL.md` set to `coding` for portable Agent Skills discovery.

See [issue 14](https://github.com/dragoscirjan/ai/issues/14) for the family architecture and [issue 15](https://github.com/dragoscirjan/ai/issues/15) for this implementation phase.
