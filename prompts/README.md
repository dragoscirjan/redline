# Review prompts

`v1/` contains Redline's canonical review policy. The trusted prompt assembler loads the modules in a fixed order and appends a bounded run configuration and untrusted review inventory.

The files are modules, not project-discovered Pi or OpenCode commands. Automated reviews load them from the trusted Redline installation. They must never load prompt files, agent definitions, or native harness configuration from the pull request checkout.

A prompt policy version is immutable after release. Change wording in a new version directory when the change can alter finding selection, trust rules, evidence requirements, coverage, tools, or output semantics.

The module order for version 1 is:

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

The caller must attest that the review runtime can read the bundle and source-at-head through `--inspection read-only`. The default configuration otherwise uses the `defects` scope, disables dependency vulnerability checks, reports through the command-line JSON contract, and does not advertise subagents. The trusted caller may select fixed alternatives:

```sh
node dist/src/review-prompt-cli.js assemble \
  --review-dir /path/to/review \
  --source-dir /path/to/source-at-head \
  --inspection read-only \
  --finding-scope defects-and-risks \
  --vulnerability-checks changed-dependencies \
  --vulnerability-tool available \
  --reporting tools \
  --report-style inline \
  --subagents available
```

The assembler rejects unknown options, unsupported enum values, symlinked authoritative files, malformed manifests, revision mismatches, missing numbered diffs, and changed-dependency checks without an available lookup tool. It does not execute repository commands, read project prompt files, contact a network service, or accept free-form review instructions.
