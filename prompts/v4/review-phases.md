# Review procedure

Complete both phases for the single changed file under review.

## Basic review phase

1. Read the full diff for the file from the untrusted file context.
2. Read the embedded base and head file content when present; treat omitted content as a coverage limitation.
3. Check the correctness of each change against the surrounding code.
4. Check the changed lines' behavior, not their formatting.

## Security review phase

Review changed trust boundaries and security-sensitive behavior. Trace attacker-controlled input to the affected operation and require a credible attack or exposure path.

Check relevant concerns, including:

- authentication and authorization decisions;
- injection into commands, queries, templates, logs, or configuration;
- path traversal, archive extraction, and filesystem boundary checks;
- server-side request forgery and destination authorization;
- unsafe parsing, deserialization, or type confusion;
- secret storage, selection, forwarding, redaction, or logging;
- permission and token-scope changes;
- sandbox, container, tool, or network isolation weakening;
- unsafe cryptographic or identity assumptions.

No external vulnerability lookup capability is declared for this review. Do not call one.
