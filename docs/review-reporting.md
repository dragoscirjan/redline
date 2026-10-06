# Review output

The review tool writes per-file records and a run summary into `REDLINE_OUTPUT_DIR` under `reviews/`. The JSON records are the machine-readable contract for later GitHub comment publication; the Markdown records are the human-readable counterpart. Nothing is published to GitHub in the current milestone — the output travels as the `<artifact-name>-reviews` artifact.

## Presenting findings: `file:x-y` spans

A file with multiple issues carries multiple findings, one span each. Every finding identifies its affected region as a line span — presented as `src/example.ts:3-5` throughout the output (a single line renders as `src/example.ts:3`). The span endpoints must both be changed lines of the claimed side; the span may include unchanged lines between them.

## Per-file record

`reviews/<fileId>.json` and `reviews/<fileId>.md`:

```json
{
  "version": 2,
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
      "startLine": 3,
      "endLine": 5,
      "evidence": "const value = compute(input);",
      "impact": "Returns the wrong value for empty input.",
      "fix": "Restore the empty-input guard.",
      "suggestion": "-const value = compute(input);\n-context\n+const value = guarded(input);",
      "fixPrompt": "Fix one code-review finding.\n…"
    }
  ],
  "durationMs": 4210,
  "rawModelOutput": "{ … the model's review document … }"
}
```

- `outcome` is `clean`, `findings`, or `omitted`. A file is `omitted` when it cannot be fully reviewed: binary content, a harness failure or timeout, model output that failed validation, or a preparation failure (an unreadable diff or a prompt that exceeds its byte limit).
- `errorKind` distinguishes `harness-failed`, `harness-timeout`, `invalid-output`, and `preparation-failed` when present.
- `side` is `LEFT` for removed lines (old file) and `RIGHT` for added lines (new file); `startLine`/`endLine` are line numbers on that side.
- `evidence` is the exact content of `startLine` on that side, without its diff marker.
- `id` is a stable hash of the finding's normalized fields, used for deduplication.
- `rawModelOutput` keeps the bounded model document for debugging; it is not published.

## Change suggestions

Each finding may carry a `suggestion`: a unified-diff-style block — `-` the current span lines, `+` the proposed replacement — rendered from authoritative content. The span content comes from the review diff itself (its changed and context lines) or, when the span reaches beyond it, from the head file (RIGHT side) or the captured base file (LEFT side). Suggestions are produced only when the model proposed a concrete replacement in its review document and the replacement actually changes the span; a proposal identical to the current content is dropped. Humans can apply the suggestion directly; coding agents can consume it verbatim, and a future GitHub publisher can convert it into a `suggestion`-format comment because the path, side, and span travel with the finding.

## Fix prompts

Each finding also carries a `fixPrompt`: a deterministic, ready-to-use prompt for a coding LLM that applies the fix. It embeds the `file:x-y` span, the finding's evidence, impact, and fix guidance, the current span content when resolvable, and the proposed change when present, followed by rules that keep the change minimal. The finding text is quoted data: the prompt instructs the agent to verify it against the cited lines before changing anything. Spans longer than 200 lines or 16 KiB are cited but not embedded.

## Findings

A finding is accepted only after validation against the authoritative diff:

- the file is not binary;
- the classification respects the configured finding scope (`risk` requires `defects-and-risks`);
- both `startLine` and `endLine` are changed lines on the claimed side, with `startLine <= endLine`;
- `evidence` is byte-identical to the `startLine` content on that side;
- at most 10 findings per file, deduplicated by their stable id.

Model output that fails schema or diff validation marks the file `invalid-output`/`omitted`; unvalidated findings are never written. All persisted model-derived text — reasons, diagnostics, raw output, suggestions, and fix prompts — is redacted against the selected credential before artifacts are written.

## Run summary

`reviews/summary.json` and `reviews/summary.md`:

```json
{
  "version": 2,
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
    {
      "fileId": "000001",
      "path": "src/example.ts",
      "outcome": "findings",
      "findingCount": 1,
      "findingSpans": ["3-5"]
    }
  ]
}
```

The summary counts every manifest file; `findingSpans` lists each published finding's span. Files the bundle excluded from review are absent from `files`; `manifestFiles - reviewedFiles` is that excluded count.

## Schema versions

- Review document (harness output): version 2 — introduced spans (`startLine`/`endLine`) and `suggestedChange`.
- Per-file record: version 2 — findings carry spans, rendered `suggestion`, and `fixPrompt`.
- Run summary: version 2 — `findingSpans` added.
- Review policy: `redline-file-review/v2`, hosted in `prompts/v4/`. The directory number tracks the repository's policy lineage (v1–v3 are prior designs); the policy ID tracks the per-file review contract.
