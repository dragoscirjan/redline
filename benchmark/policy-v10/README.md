# v10 policy deterministic replay

These reports replay existing checked-in responses and timings through the current validators and `prompts/v10/` assembler. They are not new model captures and do not measure native MCP-assisted review quality, recall or false positives.

- `quality/` uses the unchanged `benchmark/review-quality/v2` corpus.
- `performance/` uses the unchanged 20-file performance corpus/profile.
- `verification/` uses the existing scripted corpus and dispositions. Independent verification remains disabled.

Historical v9 and earlier reports remain unchanged. Native CLI and Docker integration are verified separately using real Pi/OpenCode processes, synthetic model/MCP endpoints, global and checkout-local configuration, and observed successful extra-MCP calls.
