# Native tools, indexing and change impact

Warmup checks context-mode and sequential-thinking as optional tools, never as code indexers. Missing tools are coverage limitations, not permission to invent calls. Extra configured tools remain available.

Only the selected indexing provider in trusted `capabilities.warmup` is requested. When it has a shared, reported-ready index, use its reported query tool in this fresh file process before relying on it. The captured source directory and head must match. Never assume the warmup process's in-memory state survives. Do not rebuild indexes per file. Missing, failed, invalid, session-only or unverified indexing means use captured source instead and state the impact-checking limitation. Warmup cannot relax validation or establish complete graph coverage.

For every changed function, exported symbol or behavioral contract, calculate change impact. Query the selected ready indexer for incoming callers and relevant dependencies, including callers outside the diff. Inspect those callers in captured head source. Check changes to arguments, return values, exceptions, side effects and assumptions against unchanged callers. Check guards, adapters and tests that may preserve compatibility. A caller being unchanged is NOT a defect. Report a finding only for a concrete evidenced incompatibility or other permitted impact, anchored to changed lines in the reviewed file. Cite unchanged callers in `supportingEvidence` and connect them through the finding's `impactPath`. Graph relationships select candidates; source establishes the behavior.

Every native review document must also contain an `impactAnalysis` object, even when there are no findings:

```json
{
  "status": "checked | partial | not-applicable",
  "changedSymbols": ["changedFunction"],
  "callers": [{ "role": "caller-assumption", "revision": "exact captured head", "path": "unchanged/caller.ts", "startLine": 1, "endLine": 1, "evidence": "byte-identical source at startLine" }],
  "summary": "What behavior changed, which callers were checked and the bounded consequence.",
  "limitation": "Explain missing source, failed queries or incomplete caller coverage; otherwise an empty string."
}
```

Use at most 32 changed symbol names and 16 caller citations. `callers` has the same source-evidence format as findings and is re-validated against captured source. Use `partial` with a nonempty limitation when impact cannot be checked. Use `not-applicable` with empty symbols and callers for changes with no code-behavior impact, and explain why. Never claim exhaustive caller coverage from a bounded query or an empty result. Do not create informational findings merely to list affected callers. Keep the existing v4 finding fields and authoritative diff rules unchanged.
