# Review output

Redline writes its review contract under `REDLINE_OUTPUT_DIR/reviews/`. The PR-level record is authoritative. Per-file records and the legacy run summary remain for inline publication, diagnostics, benchmark compatibility, and migration.

| Files | Purpose |
| --- | --- |
| `review.json`, `review.md` | Authoritative PR-level findings, coverage, limitations, and verdict |
| `<fileId>.json`, `<fileId>.md` | Validated per-file triggers, remediation guidance, and candidate diagnostics |
| `verification/<fileId>.json` | Opt-in verifier dispositions and bounded, credential-redacted raw output; absent when no verifier ran |
| `follow-up/<fileId>.json` | Bounded action-owned requests, pinned provider identity, resolved head-source anchors, and explicit unavailable reasons |
| `summary.json`, `summary.md` | Version-3 compatibility summary for existing benchmark/report consumers |

The output travels in the `<artifact-name>-reviews` artifact. When a publication token is supplied, the publisher consumes `review.json` for the managed PR summary and the per-file records for diff-anchored inline comments.

## PR-level record

`review.json` is version 2. Its top-level shape is:

```json
{
  "version": 2,
  "base": "…full base commit…",
  "head": "…full head commit…",
  "findings": [],
  "synthesis": { "version": 1, "groups": [], "decisions": [], "budgets": { "fileReviews": 25, "inlineComments": 100 } },
  "rejectedCandidates": [],
  "coverage": {},
  "limitations": [],
  "verdict": {
    "status": "mergeable | mergeable-after-verified-fixes | human-decision-required | inconclusive | blocked",
    "reasons": []
  },
  "files": [],
  "legacySummaryVersion": 3
}
```

Each PR finding keeps exactly one changed-diff trigger through `triggerFileId`, `triggerPath`, `side`, `startLine`, `endLine`, and byte-identical `evidence`. A single finding can also carry:

- multiple `supportingEvidence` locations at the exact base or head revision;
- bounded provider-derived `graphReferences`;
- a source- or graph-backed `impactPath`;
- dimensions, classification, severity, and confidence;
- behavioral contract, failure scenario, reachability, root cause, impact, blast radius, and reversibility;
- assumptions, counter-evidence, and remaining uncertainty;
- remediation guidance, a regression-test proposal, and explicit verification/remediation states.

This permits one cross-file finding without moving its publication anchor away from the authoritative diff.

## Evidence validation

The trigger remains subject to the strict diff validator:

- the file must be textual;
- both span endpoints must be changed lines on the declared side;
- `evidence` must exactly equal the trigger start line;
- the classification must respect the configured finding scope.

Supporting source evidence is re-read from captured repository content. Head evidence resolves from exact-head source. Base evidence resolves from captured base files, including deleted and renamed paths. The revision must equal the reviewed base or head commit, the path must be normalized and captured, the inclusive range must contain valid existing source lines, and its start-line evidence must match exactly. `SourceEvidence.evidence` contains only the anchor line: interior lines carry no claimed text, so validation confirms their location and bounds, not their contents or the causal interpretation of the range.

Graph references are provenance, not source authority. The discovery contract accepts them only when they carry the selected provider and exact version, the loaded base snapshot, the declared `related-spans` capability, a bounded query and relationship, and an action-produced SHA-256 digest from the source-resolved context. The artifact parser binds each query, relationship, resolution, and digest to its exact related span; the review validator then requires that digest to belong to the loaded fact set. A model-generated, self-consistent digest is rejected. Graph references never determine inline comment paths or line numbers. Current action-owned indexes are base-revision graphs; a claimed head graph snapshot is rejected rather than guessed.

Impact-path steps index either `supportingEvidence` or `graphReferences`. A complete path needs at least one valid step. Partial or unresolved paths require an explicit limitation.

## Independent candidate handling

Harness output uses review-document version 4 under policy `redline-file-review/v4`. A version-4 document can include up to four candidate-indexed `contextRequests` with only `incoming` or `outgoing` directions; it cannot provide paths, queries, provider commands, or budgets. Versions 2 and 3 remain accepted for existing recordings. Candidates are parsed and validated independently. One malformed schema, invalid trigger, mismatched source location, unsupported provider claim, or bad graph digest produces a bounded `rejectedCandidates` entry; it does not erase unrelated valid siblings. Findings may share a changed trigger: exact duplicates collapse, while distinct category/title identities remain separate. Only claims with the same category/title identity and incompatible classifications or severities are rejected as conflicts. A rejected candidate is never published.

If every candidate fails, the file is `omitted` with `invalid-output`. Mixed valid and invalid candidates retain the valid findings while the rejected count makes required baseline coverage incomplete, preventing a clean verdict.

Raw model output remains a bounded diagnostic field in the per-file artifact. It is not part of the publishable finding contract.

The library runner also supports an **opt-in** independent verifier for benchmark evaluation. Each candidate-bearing file gets a fresh harness invocation using the configured model and a separate fixed `redline-verification/v1` policy; clean files make no verifier call. Its timeout is 10 minutes per file. A publishable disposition must cite captured base/head source (the changed trigger may suffice). Malformed output, failed execution, or unsupported citations suppress all of that file's candidates and record incomplete required coverage. Explicitly disproved or duplicate candidates are artifact-only but count as completed verification, not missing coverage. The file record includes candidate-verification counts and duration; the separate version-1 verifier artifact stores candidate IDs, dispositions, bounded reasons, and redacted raw output. Discovery raw output remains in the per-file record. A requested follow-up is converted to a fixed depth-one, fan-out-eight, result-eight request by review code. Only trusted action code may execute it against a matching pinned **base** graph: the worker checks reviewed file identity, provider/version, graph state, base revision, query limits, and captured head-source anchors. The review core revalidates returned anchors independently before the verifier can cite them. Per-file and cumulative request budgets, worker timeouts, malformed output, missing providers, and stale snapshots yield explicit incomplete required coverage; graph labels alone cannot confirm a finding. No model-controlled path or query reaches the provider. The GitHub Action and standalone CLI do **not** activate the verifier or this path: independent live-model quality and latency gates must pass first.

## Coverage and limitations

Coverage facets use only these states: `completed`, `incomplete`, `unavailable`, and `not-applicable`. Absence is never treated as success.

The PR record states:

- considered and omitted files;
- changed-symbol availability;
- diff, base-source, head-source, and indexed-context retrieval;
- required baseline specialist completion;
- whether tests, contracts, schemas, and configuration were independently inspected;
- selected code-intelligence provider, version, base/head snapshots, capabilities, cache state, and bounded diagnostics;
- graph-query and impact-traversal status;
- source-confirmed and provider-derived relationship counts;
- provider disagreement, unresolved symbols, unsupported languages, and dynamic-behavior uncertainty;
- truncation, finding, source-byte, and related-span budgets;
- rejected candidates, opt-in verifier completion and explicit falsifications, action-owned follow-up completion, synthesis publication budgets and suppressions, remediation availability, and fix-verification availability.

Unavailable optional code intelligence is explicit but does not by itself make the run inconclusive. An omitted required file, invalid candidate, or inconclusive verifier makes required baseline coverage incomplete. A successful verifier falsification or deduplication is recorded but does not invalidate otherwise complete coverage.

## Deterministic verdicts

The model cannot select the PR verdict. Redline derives it from validated findings and coverage:

- `blocked`: at least one unresolved validated defect remains;
- `human-decision-required`: unresolved evidenced risks, test gaps, design debt, or questions remain without a defect blocker;
- `inconclusive`: required coverage is incomplete or a candidate failed required validation, and no stronger finding consequence applies;
- `mergeable-after-verified-fixes`: findings remain in the record, but each finding and remediation is independently confirmed/verified;
- `mergeable`: no validated findings remain and every required coverage facet completed.

Verified runs synthesize source-backed root-cause groups, retain every changed-line trigger, and choose a deterministic representative. They sort by severity, reversibility, source-evidence strength, and bounded confidence; model prose cannot set the rank or verdict. Incompatible source-backed contracts require human judgment. File-review (25) and inline-comment (100) budgets apply **after** ranking. Duplicate, conflict, unverified, and budget-suppressed findings remain in `review.json`/`review.md` decisions. Confirmed critical suppression adds a required coverage limitation; all suppression counts and bounded examples appear in the managed PR summary. The publisher uses only the saved plan and fails closed if a verified review has no plan.

The discovery stage accepts only `verification.status: unverified` and remediation status `guidance` or `proposed`. It cannot verify itself. The opt-in verifier can set confirmed source-backed findings; it cannot independently verify a proposed fix, and production execution remains disabled pending the benchmark gate.

## Per-file records and remediation

Per-file records are version 4. Every record includes `rejectedCandidates` and rich findings. Each accepted finding receives:

- an optional `suggestion` rendered from authoritative span content plus the model's bounded replacement text;
- a deterministic `fixPrompt` that cites the validated location, evidence, impact, current source, and remediation guidance.

GitHub inline comments remain anchored only to the validated trigger. Supporting evidence, graph references, and impact paths explain the finding but cannot relocate publication.

## Compatibility and migration

Migration is explicit:

- Harness review document version 4 adds bounded candidate-indexed follow-up intents; versions 2 and 3 remain readable.
- Version-2 harness documents remain accepted during migration. Redline maps their validated fields into version 4 records and labels every unavailable rich field as legacy-derived or unresolved; it does not reinterpret missing evidence as completed analysis.
- Per-file record version 4 adds the rich finding and rejected-candidate contract.
- PR-level record version 2 adds optional synthesis and publication coverage. The publish-only loader migrates legacy version-1 non-verified records; a verified version-1 record cannot bypass the synthesis plan and fails closed.
- Run summary version 3 remains unchanged as a subordinate compatibility artifact.
- Review policy `redline-file-review/v4` lives in `prompts/v6/`. Earlier prompts remain archived for versioned recordings.

Fix execution and learning stages are not implemented. The follow-up worker and synthesis plan are implemented behind the verifier activation gate; they are not production quality claims.
