# Review prompts

The trusted per-file assembler in `src/review/prompt.ts` loads `v11/` in this order:

1. `core-policy.md`
2. `review-phases.md`
3. `file-reporting.md`

Native CLI/Docker additionally loads `native-warmup.md`; isolated execution does not receive native-only warmup instructions.

The assembler contract ID is `redline-file-review/v11`. Contract v11 distinguishes native CLI/Docker execution from isolated Actions execution. Native prompts use bounded, normalized model-warmup hints for the captured source/head, confirm graph queries in each fresh file process, and avoid unavailable/session-only indexes. Warmup does not change permissions or authoritative finding validation. Native prompts use the harness's actual global and checkout-local tool catalog and permissions; an empty Redline tool list does not disable configured MCPs. Isolated prompts retain the verified read-only allowlist and captured-source confinement. Both modes preserve bounded `retry-enriched-v1` source context, authoritative diff/evidence checks and the version-4 JSON finding contract. Tool availability, successful calls and semantic correctness are separate claims. Independent verification remains disabled.

Directory numbers identify fixed policy-text revisions. The assembler contract ID versions prompt assembly separately; its numeric suffix need not equal the directory number. Contract tests check the documented ID against the assembler and the loaded modules, not by deriving a directory name from that suffix.

Earlier version directories remain historical references and are not loaded by the production assembler. Prompt policy is immutable after release; behavior-changing wording requires a new directory, a new policy ID/version, and updated contract tests.

The assembler loads modules only from the trusted installation. Reviewed diff/source data stays inside a length-delimited user payload. Native Pi appends the review policy to its normal system context; native OpenCode merges a review agent into its normal configuration. Native configuration may load user instructions, MCPs and plugins, and does not provide a sandbox. Docker or user-provided isolation controls that execution. Actions retain their isolated generated configuration until the separate Docker migration.

The optional Pi/OpenRouter request profile constrains generation with `src/review/generation-schema.ts`. Its fixed schema is not repository-selected and does not replace the shared result and source/diff validators. Candidate verification retains its separately versioned policy in `verification/v3/` and remains gated off in production.
