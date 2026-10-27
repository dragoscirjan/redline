# Review prompts

The trusted per-file assembler in `src/review/prompt.ts` loads `v8/` in this order:

1. `core-policy.md`
2. `review-phases.md`
3. `file-reporting.md`

The assembler contract ID is `redline-file-review/v7`. Contract v7 adds the bounded `retry-enriched-v1` source mode; the fixed policy text remains in `v8/`. Models return one version-4 JSON document per file. Version 8 adds concise protocol checks, valid clean/omitted examples, bounded static-head provenance rules, and explicit checks of outer guards, fallbacks, callers and tests before claiming end-to-end impact. This does not prove semantic correctness or activate independent verification.

Directory numbers identify fixed policy-text revisions. The assembler contract ID versions prompt assembly separately; its numeric suffix need not equal the directory number. Contract tests check the documented ID against the assembler and the loaded modules, not by deriving a directory name from that suffix.

Earlier version directories remain historical references and are not loaded by the production assembler. Prompt policy is immutable after release; behavior-changing wording requires a new directory, a new policy ID/version, and updated contract tests.

The assembler loads modules only from the trusted installation. Repository data stays inside a length-delimited user payload and cannot change policy, schemas, tools, permissions or credentials. Pi and OpenCode have all tools disabled; their event streams are transport, not model-facing publication protocols.

The optional Pi/OpenRouter request profile constrains generation with `src/review/generation-schema.ts`. Its fixed schema is not repository-selected and does not replace the shared result and source/diff validators. Candidate verification retains its separately versioned policy in `verification/v3/` and remains gated off in production.
