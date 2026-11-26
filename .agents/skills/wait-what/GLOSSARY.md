# Default glossary

## Language

**Issue tracker**:
The tool that hosts a repo's issues: GitHub Issues, Linear, a local `.scratch/` markdown convention, or similar.
_Avoid_: backlog manager, backlog backend, issue host

**Issue**:
A single tracked unit of work inside an **Issue tracker**: a bug, task, spec, or implementation slice.
_Avoid_: ticket, except when quoting external systems that use that term or referring to a **Decision ticket**

**Decision ticket**:
A child **Issue** that holds a question whose resolution is a decision, not implementation work.

**Triage role**:
A workflow state assigned to an **Issue** during triage.

## Relationships

- An **Issue tracker** holds many **Issues**.
- An **Issue** carries one **Triage role** at a time.
- A **Decision ticket** is a child **Issue**.

## Ambiguities

- "backlog" can mean the issue-tracking tool or the work inside it. Use **Issue tracker** for the tool and describe the collection of issues when referring to the work.
- Use **Issue tracker** instead of "backlog backend" or "backlog manager".
