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

Build the TypeScript command, then give it a host-generated review bundle and the exact source-at-head directory:

```sh
pnpm run build
node dist/src/review-prompt-cli.js assemble \
  --review-dir /path/to/review \
  --source-dir /path/to/source-at-head \
  --inspection read-only
```

The command writes the prompt to standard output and writes policy and prompt digests to standard error. Redirect standard output to a private file or pipe it directly to a review backend. Do not log the prompt because its untrusted inventory contains repository paths and metadata.

The caller must attest that the review runtime can read the bundle and source-at-head through `--inspection read-only`. The default configuration uses the `defects` scope, disables dependency vulnerability checks, emits versioned review events, uses single-block publication, and does not advertise subagents. The trusted caller may select fixed alternatives:

```sh
node dist/src/review-prompt-cli.js assemble \
  --review-dir /path/to/review \
  --source-dir /path/to/source-at-head \
  --inspection read-only \
  --finding-scope defects-and-risks \
  --vulnerability-checks changed-dependencies \
  --vulnerability-tool available \
  --reporting events \
  --report-style inline \
  --subagents available
```

The assembler rejects unknown options, unsupported enum values, symlinked authoritative files, malformed manifests, revision mismatches, missing numbered diffs, and changed-dependency checks without an available lookup tool. It does not execute repository commands, read project prompt files, contact a network service, or accept free-form review instructions.

## Event handling

Pi runs in JSON event mode. Trusted host code extracts assistant `text_delta` events and feeds them to the shared review-event parser.

OpenCode runs with raw JSON events. The fixed `redline-report-plugin.js` output adapter forwards `message.part.delta` text only when the trusted host sets `REDLINE_REPORT_EVENTS=1`. It does not add a model tool or receive forge credentials.

Every complete finding line can be validated and persisted before backend exit. If the backend exits without a completion event, the host retains accepted findings and finalizes the report as incomplete. A timeout before the first complete finding event cannot preserve a finding.
