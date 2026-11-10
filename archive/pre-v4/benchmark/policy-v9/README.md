# v9 policy deterministic replay

These reports replay the existing checked-in responses and timings through the current validators and prompt assembler. They update prompt-volume accounting for `prompts/v9/`. They are not new live-model captures and do not measure MCP-assisted review quality, recall, completion rate or false positives.

- `quality/` uses the unchanged `benchmark/review-quality/v2` corpus.
- `performance/` uses the unchanged 20-file `benchmark/performance/v1` corpus/profile.
- `verification/` uses the existing scripted verification corpus/dispositions. Independent verification remains disabled.

The default deterministic `benchmark:performance` command writes `benchmark/policy-v9/performance`. Historical v8 reports and earlier timing inputs remain unchanged. Native MCP behavior is tested separately against synthetic loopback models; those tests establish tool execution and enforcement, not model quality.
