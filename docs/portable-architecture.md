# Portable review application

The local CLI and existing GitHub integration share the review runner, bundle builder, prompt policy, validation, artifact schemas, and harness executors. Revision capture and presentation remain outside the review core.

```text
redline review -> validated LocalOptions -> ReviewApplication
                                             |
                         +-------------------+--------------------+
                         |                   |                    |
                    RevisionSource      runFileReviews      CompositeReporter
                         |                   |                    |
                   GitRevisionSource    ReviewWriter          CliReporter
                    isolated objects    JSON + Markdown      bounded terminal

redline-review -> existing environment/publication modes
                         |
                 executePreparedReview -> same runFileReviews
```

## Responsibility boundaries

| Pattern | Concrete responsibility |
| --- | --- |
| Ports and Adapters | `RevisionSource`, `ReviewReporter`, `ReviewWriter`, and the existing `HarnessExecutor` separate source capture, output, persistence, and model execution. |
| Application Service / Facade | `ReviewApplication.run()` orders preflight, capture, optional context preparation, review, reporting, and disposal. `executePreparedReview()` preserves the prepared-bundle compatibility path. |
| Command | A validated `ReviewCommand` supplies explicit review configuration; the application does not read argv or ambient environment. |
| Strategy / Adapter | `GitRevisionSource` captures Git states; `CliReporter` presents validated results. The existing harness registry selects Pi, OpenCode, or echo. |
| Factory / capability registry | The local composition root chooses adapters after `requireCapability()` checks known IDs. Planned values fail explicitly rather than loading arbitrary plugins. |
| Composite | `CompositeReporter` preflights all children, isolates runtime failures, and records adapter IDs that failed. |
| Observer | Discriminated `ReviewEvent` values carry content-free lifecycle progress. The review-plan event exposes only bounded file IDs and review eligibility in manifest order; per-file events expose only identity and outcome. Events contain neither source paths nor model payloads. |
| Dependency injection | Source, reporters, artifact writer, execution function, cancellation signal, streams, and existing runner clock/executor seams are supplied explicitly. |

There is no inheritance hierarchy or plugin loader. Adding an adapter requires trusted package code and tests, not repository configuration. A pattern is used only when it has a concrete responsibility.

## Capture is not review policy

`src/local/` owns CLI parsing, trusted user configuration, Git process controls, immutable capture, and terminal rendering. `src/application/` owns ordering and contracts. `src/review/` still owns fixed prompts, bounded evidence, model-result validation, synthesis, reuse, and deterministic artifact writing. `src/code-index/context.ts` prepares revision-bound context through the shared Python artifact builder in `src/code-index/export.py`. The source port supplies immutable base/head exports; local tool discovery stays in `src/local/context.ts`. The action keeps compatibility entrypoints under `github/code-index/`. `src/publish/` retains existing managed GitHub publication.

`buildBundle()` accepts a bounded Git command port. The existing context-bundle CLI uses its original implementation; the local revision adapter supplies a scratch-repository implementation. Local capture does not require modifying the existing manifest or review schemas.

A working-tree review writes synthetic tree/commit objects into temporary metadata using read-only alternates to the original object store. It never copies hooks, index extensions, repository config, or executable attributes. Staged review reads stage-zero object IDs. Unstaged review compares a synthetic index baseline against captured working bytes. Eligibility still comes from the chosen committed base.

## Context preparation

A captured revision can expose a provider-neutral context snapshot: namespace, immutable base/head IDs, and a lazy bounded source exporter. The application injects context preparation between capture and review. It does not construct environment-variable workarounds or move provider logic into a forge adapter.

The local composition root resolves only separately installed trusted providers/runtimes. The shared builder indexes sanitized base source with repository/provider configuration excluded, queries bounded relationships, and re-resolves related spans from captured head source. The same artifact loader and prompt builder then serve local and GitHub execution. Model/publication credentials never enter provider environments. Pinned CGC machine output uses a fixed wide terminal width because CGC 0.5.7 otherwise wraps long path strings inside JSON.

Unavailable or invalid context records explicit file-only coverage. Required mode checks every reviewed file after source validation and aborts before model calls on any file-only gap. Local provider state is per-run scratch and removed after preparation; persistent action cache orchestration remains unchanged. An imported artifact bypasses provider execution but not identity, schema, path, or source validation. No verifier is activated.

## Artifacts precede reporters

Artifact writing is mandatory and separate from output adapters. Reporters cannot select review files, change prompts, relax validation, or provide a verdict. Completion reporters receive a publication-safe projection containing the validated review, summary, omission classifications, and output path, not raw per-file model output. Each reporter receives an independent copy, so mutation cannot alter the authoritative result or another reporter's input.

Preflight failure aborts before source capture. Progress/completion failures are isolated; valid review artifacts remain available and the local CLI reports a nonzero reporter outcome. The application disposes a successful capture on completion or execution failure. The source adapter owns cleanup if capture itself fails.

The terminal adapter can also read bounded excerpts through `FindingDiffReader`, scoped to the private captured bundle supplied by the composition root. It verifies base/head identities and file IDs/paths, checks changed-line evidence and both span endpoints, and clips excerpts without modifying review records. It reads neither live repository files nor model-generated replacements as original diff context. Unavailable excerpts affect presentation only; artifacts, coverage, verdict, and exit policy remain authoritative.

## Compatibility and future work

The GitHub Action continues to invoke `src/review/cli.ts` with its existing `REDLINE_*` environment and two-phase publication flow. The npm `redline-review` launcher delegates to that same entrypoint. Action inputs, publication ownership/stale-head rules, output schemas, and verifier activation are unchanged. Rewiring the action belongs to #180.

Local VCS IDs: `git`, `jj`, `mercurial`. Local reporter IDs: `cli`, `github`, `forgejo`, `gitea`, `gitlab`, `bitbucket`. Only Git and the CLI reporter are implemented in the new command. Existing GitHub publication remains available through the legacy action path, not through `--reporter github` yet.

No editor protocol, TypeScript SDK, foreign-VCS semantics, or forge-specific configuration is promised by this epic. #179 defines editor JSON-RPC; the remaining roadmap epics add the other adapters. Thin editor clients must not duplicate review policy.

## Package runtime

The npm package contains trusted TypeScript source, fixed prompt data, and the shared standard-library Python exporter/JavaScript query adapter, with no runtime npm dependencies. Indexers and the optional Python helper runtime remain separately installed; no runtime or index database is embedded. Node.js does not automatically strip TypeScript inside `node_modules`; the package launchers install a synchronous load hook restricted to this package's `src/` URL prefix. The hook uses Node's `stripTypeScriptTypes()` in strip-only mode. It never loads reviewed repository modules or changes their execution permissions.

The installed tarball is tested outside the source checkout with `npm install --offline --ignore-scripts`. Both CLIs run from the installed copy. TypeScript remains checked with `tsc --noEmit` and `erasableSyntaxOnly`; there is no `dist/**/*.js` runtime contract and no install-time compiler. The CLI and artifact schemas are public contracts. Internal TypeScript modules are not exported as an SDK.
