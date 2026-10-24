# Review prompts

`v1/` contains the original aggregate JSON and model-facing publication-tool contract. It remains unchanged for auditability.

`v2/` contains the current Redline review policy. The trusted prompt assembler loads its modules in a fixed order and appends a bounded run configuration and untrusted review inventory. Version 2 removes model-facing publication tools. The model emits `redline-review-events/v1` newline-delimited JSON. Trusted host code validates, persists, and publishes those events.

The files are modules, not project-discovered Pi or OpenCode commands. Automated reviews load them from the trusted Redline installation. They must never load prompt files, agent definitions, or native harness configuration from the pull request checkout.

A prompt policy version is immutable after release. Change wording in a new version directory when the change can alter finding selection, trust rules, evidence requirements, coverage, tools, or output semantics.

The module order for version 2 is:

1. `core-policy.md`
2. `coordinator.md`
3. `basic-review.md`
4. `security-review.md`
5. `reporting.md`

## Assemble a prompt

The current per-file prompt is assembled internally by `src/review/prompt.ts` when `src/review/cli.ts` or `src/action/review.ts` runs from trusted TypeScript source. There is no standalone prompt-assembly CLI. The assembler accepts only parsed host configuration and bounded review-bundle data; it does not execute repository commands, read project prompt files, contact a network service, or accept free-form review instructions.

## Event handling

Pi runs in JSON event mode. Trusted host code extracts assistant `text_delta` events and feeds them to the shared review-event parser.

OpenCode runs with raw JSON events. The fixed `redline-report-plugin.js` output adapter forwards `message.part.delta` text only when the trusted host sets `REDLINE_REPORT_EVENTS=1`. It does not add a model tool or receive forge credentials.

Every complete finding line can be validated and persisted before backend exit. If the backend exits without a completion event, the host retains accepted findings and finalizes the report as incomplete. A timeout before the first complete finding event cannot preserve a finding.
