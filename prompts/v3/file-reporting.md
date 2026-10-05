# Reporting protocol

Return exactly one JSON document and no Markdown fences or additional prose.

The document has this shape:

```json
{
  "version": 1,
  "fileId": "000001",
  "outcome": "clean | findings | omitted",
  "reason": "bounded explanation, required when omitted",
  "findings": [
    {
      "category": "correctness | security | regression | testing | operational | maintainability",
      "classification": "defect | risk",
      "severity": "critical | high | medium | low",
      "confidence": 0.0,
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
- `fileId` must equal the `fileId` from the untrusted file context.
- `confidence` is a number from 0 through 1.
- Return at most 10 findings.
- `side` is `LEFT` for removed lines (the old file) and `RIGHT` for added lines (the new file).
- `line` and `evidence` must identify a changed line of that side exactly; `evidence` is the line content without its diff marker.
- Use `clean` only after complete inspection of the file with no findings.
- Use `findings` only after complete inspection with at least one finding.
- Use `omitted` when the file cannot be fully inspected, for example binary, unreadable, oversized, or unsupported content. Explain why in `reason`. `findings` may still contain validated findings from the inspected portion.
- `risk` is invalid when the configured finding scope is `defects`.
- Keep evidence, impact, fix, and omission reasons concise.
