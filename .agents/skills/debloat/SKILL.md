---
name: debloat
description: "Prevent overengineering during design; simplify existing code, configuration, or dependencies while preserving required behavior, contracts, security, and operational needs."
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
---

# Debloat

Prefer familiar, direct solutions that fit the project. Minimize total comprehension, maintenance, testing, security, and operating cost rather than line count. Retain complexity justified by correctness, compatibility, real boundaries, tests, recovery, or measured constraints.

## 1. Establish scope and authority

Choose prevent mode for a proposed design or simplify mode for existing code, configuration, dependencies, or abstractions. Confirm required behavior, allowed area/files, public contracts, and edit authority.

Keep reviews read-only, including generated artifacts and state-writing checks. Obtain approval for broader scope or changed contracts. Follow applicable project approval, workspace, coding, and validation gates; stop on missing instructions or unapproved tools. Read-only inventory does not itself require implementation guidance.

Continue when mode, boundaries, and authority are explicit. This skill grants no mutation or publication permission.

## 2. Investigate each candidate

Read implementation, tests, configuration, manifests, and contracts. Trace actual consumers, including public exports, plugins, CLIs, generated code, build/deployment wiring, environment inputs, and integrations where relevant. Import searches alone cannot prove disuse.

For every candidate, establish its requirement and consumers, present cost, direct alternative, behavioral/compatibility/security/test/operational risks, supporting evidence, and unknowns.

Investigate speculative extensibility, pass-through layers, duplicated facts, and apparently unused mechanisms rather than treating them as deletion orders. Defer removal when consumers or constraints cannot be verified, and name the missing evidence.

## 3. Compare and decide

In prevent mode, start with the simplest project-compatible approach to known requirements. Add a mechanism only for a demonstrated need that the direct approach cannot meet.

In simplify mode, compare the current implementation with a concrete smaller design:

| Candidate | Evidence to inspect |
|---|---|
| Factory, registry, interface, or forwarding layer | Required boundaries, isolated change, real variants, and test seams that direct calls must preserve. |
| Repeated code or configuration | A stable shared concept whose single owner reduces drift without coupling unrelated behavior. |
| Options, flags, hooks, or fallback paths | Consumers and contracts, including deployment and recovery. |
| Dependency | Runtime/build/test/transitive roles and security, compatibility, or maintenance cost of replacement. |
| Cache or optimization | Measurements and operational constraints the alternative must still satisfy. |

Retain established cryptography, authorization, error handling, observability, recovery, and necessary tests. Fewer security checks or homegrown cryptography is not simplification. Evaluate total cost, including obligations shifted to callers.

Use evidence instead of line/file/package quotas, deletion targets, interface bans, or API-use thresholds. Keep unrelated concepts separate and maintained libraries where custom replacements would add obligations.

Assign each candidate keep, simplify, or defer. Name the evidence for keeping it, the requirement-preserving alternative for simplifying it, or the unresolved risk/authority/prerequisite for deferring it. Consult [decision examples](references/decision-examples.md) when checking a disputed trade-off; examples are not deletion rules.

Continue when every candidate has an evidence-backed decision.

## 4. Apply only authorized reductions

Follow source conventions in small, reviewable steps. Establish focused behavioral coverage before removing or collapsing a mechanism; use contract or integration checks across boundaries. Report infeasible coverage before relying on weaker checks.

Preserve public behavior, defaults, errors, side effects, and compatibility unless a change is explicitly approved. Recheck consumers after rewiring, remove only newly unnecessary mechanisms within scope, and review the complete diff for collateral edits.

Run applicable gates. Preserve tests, failures, and thresholds; toolchain changes require approval. Stop and reassess when a necessary boundary or unapproved behavior change appears.

## 5. Report

Report mode/scope, evidence-backed decisions, proposed or actual changes, justified retained complexity, check results and unrun reasons, uncertainty, and the next approval needed. Keeping the current design is a valid outcome when it remains the simpler sound choice.
