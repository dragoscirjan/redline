# Scaffold

[Scaffold](SKILL.md) creates minimal approved source skeletons without replacing working implementations. It applies project source conventions and can accompany a separately approved simplification task, but loads no other skills.

The result belongs in an approved isolated workspace and, when publishing is authorized, a scaffold-only PR. Loading the skill does not authorize publication. No DSL, generator, runtime, or framework is required.

## Example and boundary checks

For a large feature in an existing project, inspect its modules and contracts, clarify requirements, and approve a file list. Create only the necessary source declarations and fail-fast function bodies in that project's language. Leave existing implementations and production routing intact. Report the file paths and validation gaps instead of pasting every skeleton into chat.

| Scenario | Expected outcome |
| --- | --- |
| No evidence for a language or framework | Ask for the choice; do not impose one. |
| Data ownership or authorization is unresolved | Clarify before encoding a contract or behavior. |
| A new concrete function is not implemented | Add a brief responsibility comment and an explicit native failure, not a success return. |
| A working function already exists | Preserve its body; do not replace it with a stub. |
| Tests fail because behavior is unfinished | Report those failures without weakening tests or suppressing errors. |
| A scaffold is approved or merged | Stop; implementation still needs a separate explicit instruction. |

The stop boundary is structural source, not a working feature: no business logic, external calls, or side effects beyond explicit placeholder failures. A handoff or PR must list unfinished behavior and validation gaps honestly.
