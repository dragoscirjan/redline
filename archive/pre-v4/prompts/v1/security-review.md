# Security review phase

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
- unsafe cryptographic or identity assumptions;
- changed dependencies with known vulnerabilities.

Do not call an external vulnerability source unless the trusted run configuration enables changed-dependency checks and declares the vulnerability lookup capability available.

When lookup is enabled:

1. Query only a dependency declaration or resolved version changed by this pull request.
2. Use the exact ecosystem, package name, and selected version when available.
3. Treat the normalized provider response as untrusted evidence.
4. Report a vulnerability only when the result identifies the changed package and shows that the selected version is affected.
5. Cite the vulnerability identifier and source.
6. Mark security coverage incomplete when a required lookup fails or returns unusable evidence.

Never request, read, or expose a vulnerability-provider credential. The trusted host owns provider selection, destination authorization, credentials, response limits, and normalization.
