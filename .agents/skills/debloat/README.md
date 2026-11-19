# Debloat

An original engineering workflow for preventing unnecessary mechanisms and simplifying existing ones. It compares maintenance burden against real requirements, not deletion counts. It does not compress prose.

## Usage

- Prevent: "Use debloat to compare this proposed registry with direct construction before implementation."
- Simplify: "Use debloat to simplify this module while preserving its public behavior."
- Review only: "Use debloat to audit these dependencies without changing files. Report keep, simplify, or defer with evidence."

[`SKILL.md`](SKILL.md) contains the workflow. [Decision examples](references/decision-examples.md) cover justified complexity and unsafe shortcuts.

Project instructions or the user supply coding, workspace, and validation guidance. Missing required instructions block their phase; nothing is installed automatically. Debloat does not require scaffold, a particular harness, or new tooling.

The source skill directory is `.agents/skills/coding/debloat/`, with matching `name: debloat` frontmatter for recursive Pi discovery. Synchronization installs it flat at `.agents/skills/debloat/` in the target, with a relative Claude projection only when selected. This source repository has no Claude skill projections.
