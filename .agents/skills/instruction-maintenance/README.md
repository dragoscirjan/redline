# Instruction maintenance

`instruction-maintenance` lets an agent detect instruction drift and propose a bounded correction without silently rewriting repository policy.

The skill covers startup routes, deferred policy documents, instruction dependencies and phase handoffs, and skill routing metadata. It does not change detailed skill behavior.

## Safety model

Loading or invoking the skill authorizes a read-only audit and an exact proposal. Repository mutation requires explicit human approval after the proposal is shown.

The proposal identifies:

- the mismatch and evidence
- current and proposed behavior
- every affected file
- exact route, policy, relationship, or metadata changes
- effects on progressive disclosure
- protected rules that remain unchanged or need separate approval
- validation and publication steps

Approval applies only to that proposal. A changed scope, changed file set, or changed protected rule requires a new proposal and new approval.

After approval, the agent still follows the repository's issue, isolated-workspace, validation, commit, and pull-request gates. Approval never grants merge or release authority.

## Relationship types

The workflow separates four relationships:

1. A trigger route loads an instruction for an event or phase.
2. A required dependency loads with another instruction because that instruction cannot work alone.
3. A phase handoff loads another instruction only when the later phase begins.
4. A reference gives context without requiring a load.

This distinction prevents dependency declarations from defeating progressive disclosure.

## Invocation

Audit a mismatch without authorizing changes:

```text
/skill:instruction-maintenance Audit why the current instructions do not cover this workflow.
```

The agent must present the exact proposal and wait for approval before mutation.

## Files

- [`SKILL.md`](SKILL.md) contains the audit, proposal, approval, and adaptation workflow.
- `README.md` explains the design and permission boundary.

Keep the directory name and the `name` field in `SKILL.md` set to `instruction-maintenance` for portable Agent Skills discovery.

See [issue 11](https://github.com/dragoscirjan/ai/issues/11) for the design requirements.
