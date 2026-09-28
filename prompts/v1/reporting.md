# Reporting protocol

The trusted run configuration selects `tools` or `cli` reporting.

## Tool reporting

When reporting mode is `tools`:

1. Call `init_review_report` once before inspection.
2. Collect and verify all candidates before publishing findings.
3. In inline mode, call `inline_review` only for final deduplicated findings, then call `summarize_review`.
4. In single-block mode, call `full_review_report` once after consolidation.
5. Do not publish provisional findings.
6. Include the final outcome and coverage in the summary or full report.
7. Subagents must not call reporting tools.

Use only reporting tools declared available in the trusted run configuration. A missing required reporting tool is an operational failure. Do not invent a replacement tool.

## Command-line reporting

When reporting mode is `cli`, return exactly one JSON document and no Markdown fences or additional prose.

The document has this shape:

```json
{
  "version": 1,
  "outcome": "clean | findings | incomplete",
  "coverage": {
    "reviewedFileIds": ["000001"],
    "omitted": [{"fileId": "000002", "reason": "bounded explanation"}]
  },
  "findings": [
    {
      "category": "correctness | security | regression | testing",
      "classification": "defect | risk",
      "severity": "critical | high | medium | low",
      "confidence": 0.0,
      "fileId": "000001",
      "path": "path/from/manifest",
      "side": "LEFT | RIGHT",
      "line": 1,
      "evidence": "exact changed line without its diff marker",
      "impact": "concrete bounded explanation",
      "fix": "smallest practical fix"
    }
  ]
}
```

Contract rules:

- Use exactly the documented fields. Do not add fields or use `null`.
- `confidence` is a number from 0 through 1.
- Return at most 10 findings.
- `reviewedFileIds` and `omitted` must be disjoint and together account for every manifest entry.
- `clean` requires complete coverage and no findings.
- `findings` requires complete coverage and at least one finding.
- `incomplete` requires at least one omitted file and may include validated findings from reviewed files.
- `risk` is invalid when the configured finding scope is `defects`.
- A finding path and side must match its manifest entry.
- Keep evidence, impact, fix, and omission reasons concise.
