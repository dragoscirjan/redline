# Reporting protocol

Return exactly one JSON document and no Markdown fences or additional prose.

The document has this shape:

```json
{
  "version": 2,
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
      "startLine": 1,
      "endLine": 3,
      "evidence": "exact content of startLine without its diff marker",
      "impact": "concrete bounded explanation",
      "fix": "smallest practical fix",
      "suggestedChange": "full replacement text for the span's lines, as it should read after the fix"
    }
  ]
}
```

Contract rules:

- Use exactly the documented fields. Do not add fields or use `null`.
- `fileId` must equal the `fileId` from the untrusted file context.
- `confidence` is a number from 0 through 1.
- Return at most 10 findings. A file with several issues carries several findings, one span each.
- `side` is `LEFT` for removed lines (the old file) and `RIGHT` for added lines (the new file).
- `startLine` and `endLine` define the span of the issue: the first and last line of the affected region on that side. Both must be changed lines of that side; the span may include unchanged lines between them. `startLine` must not exceed `endLine`.
- `evidence` is the exact content of `startLine` on that side, without its diff marker.
- `suggestedChange` is optional. Provide it when you can propose concrete replacement code: the full text that should replace the span's lines after the fix, as plain lines (no diff markers). A suggestion identical to the current span content is dropped. Omit it when the fix requires context you do not have or a decision a human must make.
- Use `clean` only after complete inspection of the file with no findings.
- Use `findings` only after complete inspection with at least one finding.
- Use `omitted` when the file cannot be fully inspected, for example binary, unreadable, oversized, or unsupported content. Explain why in `reason`. `findings` may still contain validated findings from the inspected portion.
- `risk` is invalid when the configured finding scope is `defects`.
- Keep evidence, impact, fix, and omission reasons concise.
