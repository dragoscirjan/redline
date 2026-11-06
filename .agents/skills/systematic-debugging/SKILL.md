---
name: systematic-debugging
description: Diagnose bugs, failing tests, regressions, flaky behavior, and unexpected results through evidence, root-cause tracing, and single-hypothesis experiments before proposing fixes. Use for debugging in any language, including failures across component or environment boundaries.
metadata:
  author: dragoscirjan
  version: "1.0"
  opencode/slash: "true"
  source: https://github.com/obra/superpowers/tree/22f0b463e7a5e579904dd6211a520321035526f7/skills/systematic-debugging
  upstream-commit: "22f0b463e7a5e579904dd6211a520321035526f7"
  adaptation: "Adapted by dragoscirjan from obra/superpowers (Jesse Vincent)."
---

# Systematic debugging

Establish an evidence-backed cause before proposing a corrective change. A plausible explanation is a hypothesis, not a diagnosis.

Use four phases: investigate, compare, test a hypothesis, then fix and verify. Keep the process short for a clear local defect; increase investigation when uncertainty, impact, or component boundaries require it.

## Follow project boundaries

This skill owns diagnosis. It does not grant mutation, delegation, infrastructure, or publication authority.

- Read the applicable project instructions first. Honor workspace and approval gates before diagnostic edits, generated files, tests that write state, or other mutations.
- Before changing code, load the sibling `coding` skill by its advertised name and path, then the applicable language and extension skills. If `coding` is missing, stop that phase and ask the owner to expose or install it; do not install it automatically or recreate its rules.
- Before validation, follow the project's validation instructions, including `VALIDATION.md` when applicable. Use project-owned test and tool configuration rather than introducing a competing toolchain.
- Before any delegation, load and follow the advertised `subagent-orchestration` skill. If it is unavailable, do not delegate. This skill does not create extra agent capacity.
- Read-only investigation does not require loading all implementation skills. These are phase handoffs, not instructions to preload every dependency.

## Phase 1: investigate the failure

1. Record expected behavior, observed behavior, and the exact command or action that fails.
2. Read the relevant error messages and complete stack trace. Note the failing assertion, location, revision, runtime, and environment.
3. Reproduce with the smallest safe case. Record the inputs, preconditions, and frequency. If reproduction fails, gather more evidence instead of guessing.
4. Inspect relevant changes to code, dependencies, configuration, and execution environment. A recent change is a lead, not proof.
5. Trace the failing value or state backward to where it was created or first became invalid.
6. At component boundaries, compare what entered, what left, and which configuration or state each component actually used.

Separate source evidence, observations, hypotheses, and unknowns. Avoid dumping entire environments or payloads. Never include credentials, tokens, private keys, or sensitive user data in logs, reports, or agent prompts. Capture only the necessary sanitized facts.

Choose targeted instrumentation only where evidence is missing. Make temporary diagnostics easy to remove, and do not disable safeguards to reproduce a failure.

Load only the reference that matches the problem:

| Problem | Reference |
|---|---|
| Invalid values, deep call chains, or cross-component failures | [Root-cause tracing](references/root-cause-tracing.md) |
| Timing failures, races, or asynchronous flakiness | [Asynchronous failures](references/asynchronous-failures.md) |
| A test passes alone but fails after other tests | [Test pollution](references/test-pollution.md) |

**Exit condition:** a bounded reproduction or evidence set identifies the failing boundary and the next question to test. Record any reproduction limitation.

## Phase 2: compare with working behavior

1. Find a working case in the same project, or the last known working revision or environment.
2. Compare inputs, lifecycle, ordering, ownership, dependencies, and configuration.
3. Read the relevant reference implementation and its assumptions completely before applying its pattern. Do not skim a fragment and invent the missing contract.
4. List concrete differences, including small ones. Use evidence to eliminate differences rather than assuming they cannot matter.

Do not copy working code without understanding why it works. If no working comparison exists, use the documented contract and mark the missing comparison explicitly.

**Exit condition:** the differences support a specific, falsifiable explanation.

## Phase 3: test one hypothesis

Write a short experiment record:

```text
Hypothesis: X causes the failure because evidence Y.
Prediction: changing or observing Z will produce result R.
Experiment: smallest safe test that isolates Z.
Result: observed facts, including whether the original failure still occurs.
Decision: supported, rejected, or inconclusive; next action.
```

Change one relevant variable at a time. Prefer a focused test or observation over a speculative production edit. Run mutation-capable experiments only inside the authorized workspace and scope.

- If the prediction fails, reject or revise the hypothesis. Do not stack unrelated changes.
- If the result is inconclusive, improve the experiment or request missing evidence.
- If supported, explain the causal path from the trigger to the observed failure before moving to implementation.

If an exploratory edit remains, identify whether it belongs in the final fix. Remove only your own unneeded diagnostic changes; never reset or discard pre-existing work.

## Phase 4: fix and verify

1. Create the smallest regression test or executable reproduction before applying the corrective change. Confirm that it fails for the intended reason against the unfixed behavior. An existing failing test can serve this purpose.
2. If a deterministic test is not feasible, document why and use the strongest safe reproduction or observation available. Do not present a manually observed result as automated coverage.
3. Apply the smallest change that addresses the demonstrated cause. Keep unrelated cleanup and refactoring out of the fix.
4. For invalid data or unsafe state, add checks at the responsible boundary. Add further checks only when a distinct trust boundary or bypass path justifies them. Do not duplicate validation at every layer without evidence.
5. Re-run the regression case and the broader relevant project checks. For intermittent failures, report trial counts and conditions; one passing run is not proof that flakiness is gone.
6. Remove temporary instrumentation and test fixtures you introduced unless they are an intentional part of the fix. Re-run affected checks after removal.
7. Inspect the complete diff for unintended behavior and report verification gaps.

Use `coding` for implementation standards and project validation policy for quality gates. Do not weaken tests, suppress unexplained errors, add arbitrary sleeps, or call a failure fixed because its message disappeared.

## Stop and reassess

If a fix fails, return to investigation with the new evidence. Count failed corrective attempts, not ordinary diagnostic observations.

After three failed corrective attempts for the same unresolved failure, stop further patches and reassess reproduction, assumptions, environment, shared state, coupling, and architecture. Summarize what each attempt established. Three failures are an escalation signal, not proof that the architecture is wrong.

Ask the owner before an architectural change, broader scope, or an experiment requiring additional authority. If evidence is unavailable, report a blocked diagnosis and the smallest next observation needed.

Urgent containment, such as an authorized rollback, is not a root-cause fix. Label it as containment, preserve evidence where safe, and keep the underlying diagnosis open.

## Report the result

State:

- the failure and affected revision or environment
- the cause and supporting evidence, or remaining uncertainty
- the focused change, distinct from any containment
- checks that passed, failed, or did not run, with reasons
- remaining risks and the next action

Follow the project's branch and workspace reporting requirements. Never claim a diagnosis or fix beyond the evidence collected.
