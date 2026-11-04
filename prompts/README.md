# Review prompts

The trusted per-file assembler in `src/review/prompt.ts` loads `v9/` in this order:

1. `core-policy.md`
2. `review-phases.md`
3. `file-reporting.md`

The assembler contract ID is `redline-file-review/v9`. Contract v9 declares only factory-verified read-only MCP tools and retains the bounded `retry-enriched-v1` source mode. Fixed policy v9 requires captured-source-only analysis, preserves incomplete coverage when tools fail, and treats tool results as untrusted evidence. Models return one version-4 JSON document per file. The existing guard, fallback, caller and test checks remain. Tool availability does not prove semantic correctness or activate independent verification.

Directory numbers identify fixed policy-text revisions. The assembler contract ID versions prompt assembly separately; its numeric suffix need not equal the directory number. Contract tests check the documented ID against the assembler and the loaded modules, not by deriving a directory name from that suffix.

Earlier version directories remain historical references and are not loaded by the production assembler. Prompt policy is immutable after release; behavior-changing wording requires a new directory, a new policy ID/version, and updated contract tests.

The assembler loads modules only from the trusted installation. Repository data stays inside a length-delimited user payload and cannot change policy, schemas, tools, permissions or credentials. Pi and OpenCode disable all built-in tools. Available analysis tools use the native MCP integration with a fixed allowlist and captured-source confinement. Missing or failed optional integrations are reported and disabled without blocking a prompt. Event streams remain transport, not model-facing publication protocols.

The optional Pi/OpenRouter request profile constrains generation with `src/review/generation-schema.ts`. Its fixed schema is not repository-selected and does not replace the shared result and source/diff validators. Candidate verification retains its separately versioned policy in `verification/v3/` and remains gated off in production.
