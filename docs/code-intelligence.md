# Code-intelligence contracts

Redline's code-intelligence layer defines the provider-neutral boundary between repository indexers and review-domain planning. Providers may expose different graph models, languages, confidence, and native features, but they must normalize evidence into the versioned contracts under `src/code-intelligence/`.

This layer does not make graph facts authoritative. Diff text and captured base/head source remain authoritative for published finding locations and quoted evidence.

## Current implementation status

The current milestone provides:

- versioned provider, capability, snapshot, graph-fact, query, result, and recording contracts;
- strict runtime parsing and cross-contract identity validation;
- deterministic provider and snapshot compatibility digests;
- a dependency-injected provider registry with no provider-name branching in review code;
- offline GitNexus and CodeGraphContext recordings exercised through one conformance fixture.

These contracts do not calculate change impact. Native reviews ask the LLM to assess impact through the harness and its available tools. Redline validates the reported source evidence. See [Local CLI](/local-cli) for native review behavior and coverage limitations.

Concrete GitNexus and CodeGraphContext process adapters, tool installation, and index storage are not implemented by this milestone. Tool acquisition and cache reuse belong to issue #111. The recorded fixtures verify the common contract without presenting fixture behavior as a live-provider integration.

## Provider contract

A `CodeIntelligenceProvider` owns provider-specific behavior:

- describing the pinned provider, adapter, schema, capabilities, languages, distribution, and license;
- building an index for one immutable repository revision;
- opening and validating an existing immutable snapshot;
- running bounded host-side queries;
- cleaning up provider-owned state.

Providers are registered through `CodeIntelligenceProviderRegistry`. The registry is dependency-injected and immutable: extending it creates a new registry. Adding another provider requires a registration and conformance implementation, not a switch in the review domain.

The registry intentionally has no built-in providers yet. A disabled or unavailable indexer therefore does not alter the existing file/diff-only review path.

## Capabilities

Providers declare each capability as `supported`, `experimental`, or `unsupported`. The common vocabulary covers definitions, types, references, calls, implementations, inheritance, dependencies, tests, configuration, paths, entry/terminal relationships, execution flows, native impact, graph delta, and incremental updates.

Capability absence is not an empty result. A query for an absent capability must return `unsupported`. This distinction prevents missing index coverage from being interpreted as proof that no relationship exists.

Provider-specific details remain in a bounded extension object. Common graph fields stay portable while provider semantics such as GitNexus community data or CGC tree-sitter resolution remain visible.

## Immutable snapshots

Every `CodeIntelligenceSnapshot` binds normalized facts to:

- repository identity and exact commit digest;
- source-tree and configuration digests;
- provider, provider version, adapter version, and schema version;
- declared capabilities;
- language- and file-level coverage;
- unsupported, skipped, failed, or truncated inputs.

Base and head snapshots have independent identities. Each snapshot must match its own immutable repository revision; a base-only index cannot stand in for a head snapshot. Snapshot source provenance is revision-relative, so an immutable cached revision remains reusable across pull requests.

Every node and edge carries provider, version, adapter, snapshot, revision, query, retrieval reason, status, and optional captured-source provenance. Facts with mismatched snapshot identity are rejected.

## Bounded queries

These contracts describe host-side queries, not native harness tool permissions. Host code constructs a `CodeIntelligenceQuery` with explicit depth, fan-out, result-count, byte, and elapsed-time limits. Results report observed depth and maximum fan-out so the host can validate every bound rather than trusting provider status alone. Results distinguish:

- complete and partial results;
- valid empty results;
- unsupported and unavailable capabilities;
- provider failure;
- truncation and ambiguity.

`assertQueryResultMatches` verifies immutable identity, fact provenance, capability support, and every deterministic result budget against the originating query.

## Compatibility and caching

`providerCompatibilityDigest` changes when the provider, adapter, schema, capabilities, languages, version pin, or distribution identity changes. `snapshotCompatibilityDigest` additionally binds repository revision, source tree, configuration, and snapshot contract identity.

These digests are inputs for #111 cache keys. They do not make cache availability a correctness requirement: incompatible, missing, or corrupt artifacts must be rebuilt or reported as unavailable.

## Recorded conformance

Normal unit CI loads pinned GitNexus and CodeGraphContext contract recordings from `test/fixtures/code-intelligence/`:

| Provider | Recorded distribution | Declared common capabilities | License metadata |
| --- | --- | --- | --- |
| GitNexus | `gitnexus@1.2.0` from npm | Symbol definitions, callers/callees, associated tests | The selected npm package declares PolyForm Noncommercial 1.0.0; redistribution and commercial use are conditional on the applicable license. |
| CodeGraphContext | `codegraphcontext==0.6.13` from PyPI | Symbol definitions, callers/callees, associated tests | MIT; redistribution is allowed subject to the license notice. |

The GitNexus recording additionally declares experimental native-impact traversal. Both recordings describe the same TypeScript fixture and normalize to the same portable nodes and edges for their common capabilities. Their provider extensions, capability differences, confidence, versions, distribution sources, and licenses remain distinct.

Recorded conformance is deliberately separate from opt-in live tests. A future live adapter test must pin the provider version and compare its normalized output against the same contract without executing pull-request code.

## Security boundary

Repository content, paths, provider output, and diagnostics are untrusted data. Runtime parsers reject unknown fields, invalid paths and identities, oversized extensions, malformed spans, duplicate or nondeterministically ordered facts, dangling edges, and inconsistent coverage. Providers using these contracts must operate on captured source under trusted host configuration. The contracts describe data and do not grant tool access or expose credentials. Native harness tool access follows its configuration.
