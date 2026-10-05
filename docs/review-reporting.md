# Review output

The review tool writes per-file records and a run summary into `REDLINE_OUTPUT_DIR` under `reviews/`. The JSON records are the machine-readable contract for later GitHub comment publication; the Markdown records are the human-readable counterpart. Nothing is published to GitHub in the current milestone — the output travels as the `<artifact-name>-reviews` artifact.

## Per-file record

`reviews/<fileId>.json` and `reviews/<fileId>.md`:

```json
{
  "version": 1,
  "fileId": "000001",
  "path": "src/example.ts",
  "status": "M",
  "harness": "pi",
  "model": "z-ai/glm-5.3-flash",
  "outcome": "findings",
  "errorKind": null,
  "reason": null,
  "findings": [
    {
      "id": "f-3f9a…",
      "category": "correctness",
      "classification": "defect",
      "severity": "high",
      "confidence": 0.9,
      "side": "RIGHT",
      "line": 2,
      "evidence": "const value = compute(input);",
      "impact": "Returns the wrong value for empty input.",
      "fix": "Restore the empty-input guard."
    }
  ],
  "durationMs": 4210,
  "rawModelOutput": "{ … the model's review document … }"
}
```

- `outcome` is `clean`, `findings`, or `omitted`. A file is `omitted` when it cannot be fully reviewed: binary content, a harness failure or timeout, or model output that failed validation.
- `errorKind` distinguishes `harness-failed`, `harness-timeout`, and `invalid-output` when present.
- `side` is `LEFT` for removed lines (old file) and `RIGHT` for added lines (new file); `line` is the line number on that side.
- `id` is a stable hash of the finding's normalized fields, used for deduplication.
- `rawModelOutput` keeps the bounded model document for debugging; it is not published.
- The record for a file the bundle excludes from review is not written at all.

## Findings

A finding is accepted only after validation against the authoritative diff:

- the file is not binary;
- the classification respects the configured finding scope (`risk` requires `defects-and-risks`);
- the line is a changed line on the claimed side;
- `evidence` is byte-identical to that diff line;
- at most 10 findings per file, deduplicated by their stable id.

Model output that fails schema or diff validation marks the file `invalid-output`/`omitted`; unvalidated findings are never written.

## Run summary

`reviews/summary.json` and `reviews/summary.md`:

```json
{
  "version": 1,
  "harness": "pi",
  "model": "z-ai/glm-5.3-flash",
  "provider": "openrouter",
  "findingScope": "defects",
  "base": "…40-hex…",
  "head": "…40-hex…",
  "manifestFiles": 12,
  "reviewedFiles": 10,
  "omittedFiles": 2,
  "findings": 3,
  "files": [
    { "fileId": "000001", "path": "src/example.ts", "outcome": "findings", "findingCount": 1 }
  ]
}
```

The summary counts every manifest file. Files the bundle excluded from review are absent from `files`; `manifestFiles - reviewedFiles` is that excluded count.
