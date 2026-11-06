# Systematic debugging

A project-maintained skill for evidence-first debugging: investigate the failure, compare working behavior, test one hypothesis, then fix and verify.

[SKILL.md](SKILL.md) contains the workflow. Optional references cover root-cause tracing, asynchronous failures, and test pollution. Implementation, validation, workspace safety, and delegation follow the project's existing skills and policy.

## Inspiration and adaptation

Adapted by Dragos Cirjan, inspired by Jesse Vincent's [systematic-debugging skill in obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging).

This version adds project-specific handoffs, risk-based boundary checks, and reassessment after repeated failed fixes. It does not import the upstream executable scripts or project-specific TypeScript utilities.
