# Change-impact planning

Redline's change-impact layer turns an exact base-to-head change, normalized code-intelligence snapshots, and captured context into two versioned artifacts:

- `impact/change-impact.json` and `.md` describe graph deltas, change neighborhoods, bounded impact cones, path witnesses, uncertainty, test reachability, contract changes, and risk-routing inputs;
- `impact/context-plan.json` and `.md` describe the question-specific context selected for later reviewers.

The layer is forge- and harness-independent. It accepts normalized facts through `ChangeImpactInput`; it does not install or invoke GitNexus, CodeGraphContext, or another provider. Provider acquisition and snapshot production belong to the provider-neutral code-intelligence layer tracked by issue #110.

## Evidence authority

The artifacts preserve four distinct evidence classes:

1. **Source facts** — the base-to-head diff and captured base/head source. These remain authoritative for a published finding's location and quoted evidence.
2. **Provider-derived facts** — normalized symbols, relationships, capabilities, and query results. These guide retrieval and carry provider, version, snapshot, revision, query, and coverage provenance.
3. **Planning interpretation** — neighborhoods, cones, witnesses, risk signals, and context selection derived deterministically by Redline. These are review inputs, not findings.
4. **Unavailable coverage** — unsupported languages, missing snapshots, ambiguous identity, failed queries, dynamic behavior, provider disagreement, and budget truncation. These remain explicit and reduce coverage rather than being guessed away.

A provider relationship never bypasses the existing exact-diff and source validation used for published findings.

## Input contract

A `CodeIntelligenceSnapshot` identifies one immutable repository revision and contains normalized nodes and edges. Base and head snapshots are independent. A node identity shared across revisions permits comparison; uncertain continuity is reported as unresolved identity instead of being inferred.

A `ChangedTarget` links diff provenance to optional base/head symbol identities. Targets connected by normalized relationships form a change neighborhood. Unrelated targets remain separate even when they occupy the same file, while a contract and implementation can form one neighborhood across files.

Context candidates are already captured or source-resolved host data. Graph-selected candidates must include provider/query provenance and every candidate must include a selection reason, digest, ambiguity state, and truncation state. The model receives packed text, not provider tools.

## Deterministic graph analysis

The planner compares both snapshots and retains:

- added, removed, changed, and renamed nodes;
- added, removed, and changed relationships;
- base/head capability and coverage differences;
- unresolved or ambiguous identities.

For each changed target it derives five cones:

- upstream callers and observers;
- downstream dependencies and effects;
- implementations and inheritance;
- tests and fixtures;
- contracts and configuration surfaces.

Traversal uses stable identity ordering and explicit depth, fan-out, node, edge, byte, elapsed-time, and witness caps. Any cap reached is recorded on the cone and in the uncertainty map. Elapsed time is an operational safety stop; callers that require byte-for-byte fixture determinism should inject a monotonic test clock and set a sufficient production deadline.

Path witnesses are the shortest paths discovered within those bounds. They explain why context was selected; they do not prove runtime reachability.

Risk profiles select review depth and specialist dimensions. They are not findings and cannot independently block a change.

## Context packing

Each `ReviewQuestion` has independent byte and estimated-token budgets. Candidate ordering is fixed:

1. changed diff and enclosing declaration;
2. base/head spans;
3. shortest useful path witnesses;
4. direct relationships and contracts;
5. tests and fixtures;
6. state, effect, schema, and configuration evidence;
7. requirements and repository guidance;
8. justified secondary graph context.

UTF-8 byte limits are authoritative. The portable token estimate is `ceil(bytes / 4)` and is versioned in the plan. Candidates that do not fit are listed explicitly; they are never silently truncated. Candidates from another change target are excluded unless the question requests that target.

## Reduced-coverage operation

Snapshots are optional. With `mode: "file-only"`, Redline still forms diff-linked neighborhoods and packs captured diff/source/requirements candidates. Graph deltas remain empty, cones and test reachability report unavailable or unknown coverage, and uncertainty records the missing revisions. A disabled, unsupported, or unavailable provider therefore cannot prevent file/diff-only review.

`indexed-context` and `full-impact` are explicit modes so evaluation work can compare file-only, indexed, and complete impact planning over identical fixtures. The mode labels describe supplied evidence; they do not raise the authority of graph facts.

## Integration boundary

The current review runner remains file-local while issue #110 supplies provider-neutral snapshot acquisition and later PR-level review issues consume the artifacts. Integration should:

1. build or restore exact base/head snapshots;
2. resolve graph-selected spans against captured source;
3. call `deriveChangeImpact` once per PR;
4. persist both artifacts with `createChangeImpactWriter`;
5. project only the relevant question plan into each specialist review;
6. retain the existing exact-diff finding validator.

Warm caches may avoid recomputation, but correctness cannot depend on a cache hit and cache provenance must be digest-bound.
