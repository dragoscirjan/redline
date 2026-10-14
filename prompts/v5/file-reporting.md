# Reporting protocol

Return exactly one JSON document and no Markdown fences or additional prose.

The document has this shape:

```json
{
  "version": 3,
  "fileId": "000001",
  "outcome": "clean | findings | omitted",
  "reason": "bounded explanation, required when omitted",
  "findings": [
    {
      "title": "concise root-cause title",
      "dimensions": ["correctness | security | regression | testing | operational | maintainability | compatibility | data-integrity | architecture"],
      "category": "correctness | security | regression | testing | operational | maintainability",
      "classification": "defect | risk | test-gap | design-debt | question",
      "severity": "critical | high | medium | low",
      "confidence": 0.0,
      "side": "LEFT | RIGHT",
      "startLine": 1,
      "endLine": 3,
      "evidence": "exact content of startLine without its diff marker",
      "supportingEvidence": [
        {
          "role": "missing-guard | caller-assumption | contract | schema | test-gap | impact-path",
          "revision": "full base or head commit identifier",
          "path": "repository-relative/path.ts",
          "startLine": 1,
          "endLine": 2,
          "evidence": "exact content of startLine at revision/path"
        }
      ],
      "graphReferences": [
        {
          "provider": "provider id",
          "providerVersion": "exact provider version",
          "snapshotRevision": "full indexed base revision",
          "capability": "related-spans",
          "query": "bounded normalized query identity supplied by indexed context",
          "relationship": "provider-derived relationship",
          "resolution": "exact | approximate | unresolved",
          "graphFactDigest": "supplied sha256 digest of the exact graph fact identity"
        }
      ],
      "impactPath": {
        "status": "complete | partial | unresolved",
        "steps": [
          {
            "from": "bounded source or behavior",
            "to": "bounded affected source or behavior",
            "relationship": "how the impact propagates",
            "evidence": "source | graph",
            "referenceIndex": 0
          }
        ],
        "limitation": "required when status is partial or unresolved"
      },
      "behavioralContract": "applicable behavior or invariant",
      "failureScenario": "concrete failure sequence",
      "reachability": "why execution can reach the failure",
      "rootCause": "cause introduced, worsened, exposed, or relied upon by this change",
      "impact": "concrete bounded consequence",
      "blastRadius": "affected callers, data, users, or systems",
      "reversibility": "reversible | partially-reversible | irreversible | unknown",
      "assumptions": ["assumption required by the conclusion"],
      "counterEvidence": ["evidence checked that could contradict the conclusion"],
      "uncertainty": "remaining uncertainty, or a short statement that none remains",
      "fix": "complete practical remediation strategy",
      "regressionTest": "test and expected behavior before and after the fix",
      "verification": {
        "status": "unverified",
        "reason": "Independent verification has not run."
      },
      "remediationStatus": "guidance | proposed",
      "suggestedChange": "full replacement text for the trigger span"
    }
  ]
}
```

Contract rules:

- Use exactly the documented fields. Do not add fields or use `null`.
- `fileId` must equal the `fileId` from the untrusted file context.
- Return at most 10 candidate findings. Candidates are validated independently; one bad candidate will be rejected without erasing separate valid candidates.
- Every candidate must have one trigger in this changed file. Both trigger endpoints must be changed lines on `side`, and `evidence` must exactly match `startLine`.
- `supportingEvidence` is optional context, not the publication anchor. Cite only source present in the supplied file or indexed context. Use the exact base/head revision and exact source line. Use an empty array when none is needed.
- `graphReferences` are discovery provenance, never source authority. Include one only when the supplied indexed context declares the exact provider, version, base snapshot, query identity, relationship, and graph-fact digest. Never invent or compute a graph fact. Use an empty array otherwise.
- `impactPath.steps[*].referenceIndex` indexes `supportingEvidence` when `evidence` is `source`, or `graphReferences` when it is `graph`. Use `unresolved` with an empty `steps` array and a concise limitation when no validated path is available.
- `verification.status` must be `unverified`; this discovery pass cannot verify itself.
- `remediationStatus` is `proposed` only when a concrete `suggestedChange` is supplied; otherwise use `guidance`. Never claim a fix is applicable or verified.
- Use `question` for a consequential unresolved product, compatibility, migration, or architecture decision. Do not label that uncertainty as a proven defect.
- Use `clean` only after complete inspection with no candidates. Use `findings` after complete inspection with at least one candidate.
- Use `omitted` when the file cannot be fully inspected. Explain why in `reason`; findings may still contain candidates from the inspected portion.
- `risk` and `design-debt` are invalid when the configured scope is `defects`.
- Keep all text concise and evidence-based.
