---
name: retro
description: Review a bounded work period for evidence-backed process improvements, including workflow, instructions, tools, and handoffs.
---

# Retro

Find evidence-backed changes that would prevent observed process or agent-environment problems. Recommend changes; let the user choose which to adopt.

## 1. Bound and inspect the evidence

Resolve destination and format from the target project's `AGENTS.md` and `CONTRIBUTING.md`. Ask before drafting if either is unclear; let the user choose chat, a file, or a tracker.

Use the current session unless the user names another period. Read the available transcript or session record, relevant diffs, review comments, and check results. Cite evidence and state what unavailable records prevent you from verifying. Stay within the requested project and period, without searching unrelated private conversations.

## 2. Identify specific problems

- Inspect lint, type-check, and test commands, CI, and hooks. Distinguish missing checks from checks that never run or silently fail. Missing automated enforcement is a finding even when this session caught no violation.
- Inspect difficulty finding code, decisions, logs, or other context. Look for missing or stale references before proposing another document.
- Identify duplicate, conflicting, or ineffective instructions. Keep implementation guidance in force rather than moving standards exclusively to reviewers.
- Check repeated searches, costly tool output, poor task boundaries, unnecessary clarification, and handoffs that lost decisions or verification state.
- Separate lasting lessons from one-off friction. Use explicit user corrections and repeated failures as evidence rather than personal workflow preferences.

Continue when each candidate has an observation that the available record supports.

## 3. Propose and stop

For each candidate, cite the observation, explain the likely cause, name the smallest change and its destination, and state how to verify it. Separate facts from hypotheses and order candidates by impact.

Recommend deterministic checks for mechanical rules and reuse existing standards or skills for judgment calls. Keep guidance in its suitable existing location instead of adding duplicate prose.

Stop at recommendations. Instruction-graph changes require the project's human-approved maintenance process; other changes follow normal contribution rules. Edits, tool installation, and backlog publication require authorization. Report when the evidence supports no change.
