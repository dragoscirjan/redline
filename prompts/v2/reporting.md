# Reporting protocol

Return newline-delimited JSON using `redline-review-events/v1`. Do not call publication tools. Trusted host code validates, persists, and publishes accepted events.

## Stream rules

- Write one JSON object per line.
- Do not use Markdown fences or write prose outside the JSON lines.
- Emit each semantically accepted finding immediately. Do not wait to build an aggregate findings array.
- Emit exactly one `completion` event last.
- Do not emit events after completion.
- Return at most 10 finding events.

A finding event has this shape:

```json
{"version":1,"type":"finding","finding":{"category":"correctness | security | regression | testing | operational | maintainability","classification":"defect | risk","severity":"critical | high | medium | low","confidence":0.0,"fileId":"000001","path":"path/from/manifest","side":"LEFT | RIGHT","line":1,"evidence":"exact changed line without its diff marker","impact":"concrete bounded explanation","fix":"smallest practical fix"}}
```

The final event has this shape:

```json
{"version":1,"type":"completion","outcome":"clean | findings | incomplete","coverage":{"reviewedFileIds":["000001"],"omitted":[{"fileId":"000002","reason":"bounded explanation"}],"capabilityFailures":[{"capability":"vulnerabilityLookup","reason":"bounded explanation"}]}}
```

## Contract rules

- Use exactly the documented fields. Do not add fields or use `null`.
- `confidence` is a number from 0 through 1.
- `reviewedFileIds` and `omitted` must be disjoint and together account for every manifest entry.
- `capabilityFailures` records a required declared capability that failed even when file inspection completed.
- Use `clean` only for complete coverage, no capability failures, and no finding events.
- Use `findings` only for complete coverage, no capability failures, and at least one finding event.
- Use `incomplete` when at least one file is omitted or at least one required capability failed. It may follow validated findings from reviewed files.
- `risk` is invalid when the configured finding scope is `defects`.
- A finding path and side must match its manifest entry.
- Keep evidence, impact, fix, omission reasons, and capability failure reasons concise.
- If execution ends before the completion event, trusted host code treats the review as incomplete and retains valid finding events already received.
