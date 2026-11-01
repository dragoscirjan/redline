# Documentation diagrams

These diagrams explain the local CLI/RPC implementation, not deployment topology or future editor extensions. The Markdown guides retain the full text contract and accessible image descriptions. Each SVG preview links to a standalone interactive HTML view; ordinary guide pages do not load the viewer JavaScript.

## Sources and provenance

- `local-review.architecture.json` describes the shared local review path.
- `rpc-lifecycle.lifecycle.json` describes the six public RPC run states.
- Both candidates cite committed source at `60ea6f5083fab4ddc8592f27e898be7410b23bb0`. They do not claim to describe later changes automatically.
- `manifest.json` records source/output hashes and a portable summary of the generation checks. It is not an independent review or a substitute for Archify's local receipts.

The generator is Archify **v3.2.0**, pinned to commit `208acba8d412335185b2056fedf54b3405df43fb`. No Archify package, global skill or Redline runtime dependency is installed in this repository.

## Regenerate

Use an approved temporary tool directory with Node.js 24 and an existing Chrome/Chromium browser. Download the pinned source archive, rather than running a moving installer:

```sh
curl --fail --location https://codeload.github.com/tt-a1i/archify/tar.gz/208acba8d412335185b2056fedf54b3405df43fb --output source.tar.gz
```

Its SHA-256 is `7a6ee4f608c47d72c1f406be05fc30d015796f9f5006a7eda0daa79a8d695adc`. Verify that digest before extraction or execution. Extract into your temporary directory and set `ARCHIFY` to its `archify/bin/archify.mjs` path.

From the Redline worktree, run:

```sh
node "$ARCHIFY" finalize architecture docs/diagrams/local-review.architecture.json docs/public/diagrams/local-review.html --repo-root . --quality showcase --out-dir /tmp/redline-architecture-check --json
node "$ARCHIFY" finalize lifecycle docs/diagrams/rpc-lifecycle.lifecycle.json docs/public/diagrams/rpc-lifecycle.html --repo-root . --quality showcase --out-dir /tmp/redline-lifecycle-check --json
```

Use a fresh evidence directory for each changed candidate. Set command-scoped `ARCHIFY_CHROME` if browser discovery needs an explicit executable. Do not install or update a browser implicitly. A successful finalize must report passing validation, delivery, strict artifact checks and browser checks, not only a created HTML file.

When implementation changes, inspect the relevant committed source before updating repository revisions or line references. Every diagram component or state has source evidence. Preserve the distinction between whole-run deadlines, file timeouts, cancellation and completed review outcomes.

Open each finalized HTML file and use **Export → SVG · Auto** to replace its matching SVG preview. This canonical export preserves the diagram and embedded font license, without viewer controls or selected-node overlays. Keep the corresponding source/output hashes in `manifest.json` current. Inspect both diagrams in light/dark themes and check the rendered documentation with its deployment base path and a narrow viewport.

Move machine-specific `*.delivery.json` receipts out of `docs/public/diagrams/` after validation. Keep them with local evidence, not the published site. The portable manifest deliberately omits local usernames, absolute checkout paths and tool directories. Run `mise run validate` before committing.

## Licensing and scope

Archify at this pinned release uses the MIT license, preserved with the generated viewers in `/diagrams/Archify-LICENSE.txt`. The viewers and canonical SVG exports embed JetBrains Mono under the SIL Open Font License 1.1, including its full notice. These diagrams use no third-party brand marks.

The interactive views can zoom, select nodes and display their authored relationships. They do not execute repository code, connect to a model, start reviews or configure Redline. They contain no credentials, prompts, raw model records or host-specific paths. Source validation and diagram checks do not establish model diagnosis correctness.
