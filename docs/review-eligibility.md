# Review eligibility

Redline separates **required reviewable files** from files that a trusted policy explicitly excludes. An exclusion does not count as a completed review or as a required-file omission. Every excluded file stays visible with its deterministic reason in `manifest.json`, `summary.json`/`summary.md`, `review.json`/`review.md`, and the managed pull-request summary.

## Trust boundary

The context builder checks eligibility before model execution. Policy can come from only these sources:

1. the optional `review-eligibility` action or reusable-workflow input, supplied by trusted workflow code;
2. `.redline/review-eligibility.json` read directly from the exact base Git revision;
3. built-in deterministic rules when neither trusted policy source is configured.

The pull-request head is never consulted for policy. A pull request that adds or changes `.redline/review-eligibility.json` cannot suppress its own files. The policy path is always reviewable, even when the previous policy's include or exclude rules would otherwise omit it.

A workflow input overrides the base-revision file for that run. It is written to a private runner-temporary file and parsed under the same bounds. Symlinked policy files are rejected.

## Policy schema

```json
{
  "version": 1,
  "include": ["src/**", "docs/*.md"],
  "exclude": [
    {
      "pattern": "benchmark/**/capture.json",
      "reason": "generated raw benchmark capture"
    }
  ]
}
```

- `include` and `exclude` are required arrays; either can be empty.
- When `include` is non-empty, a file must match at least one include pattern or it is excluded as `outside trusted review include policy`.
- `exclude` is evaluated first. Each rule carries the reason persisted in coverage output.
- A rename or copy is checked against both old and new paths. It is excluded only when every path matches an exclude rule. Moving a file into or out of an excluded area remains reviewable.
- `*` and `?` match inside one path segment. `**` is supported only as a complete segment and matches zero or more segments.
- Patterns are repository-relative, slash-separated, and cannot contain empty, `.` or `..` segments.

The complete policy is capped at 16 KiB, with at most 32 include rules and 64 exclude rules. Patterns are capped at 256 characters and reasons at 200 characters. Unknown fields and unsupported versions fail closed.

Built-in rules continue to exclude binary diffs, lock files, and paths under generated or vendored directories such as `node_modules`, `dist`, `build`, `out`, `vendor`, and `coverage`.

## Redline's policy and evidence

This repository's exact-base policy excludes only:

```text
benchmark/**/capture.json
```

The checked-in evidence is under `benchmark/review-eligibility/v1/`. PR #171 run `40132029782` reviewed one raw model-execution capture with:

- 63,669 diff bytes;
- about 15,918 input tokens by the stable four-characters-per-token estimate;
- 3,987 ms observed model time;
- zero findings and zero rejected candidates.

That raw capture was 30.03% of the pull request's diff bytes. The generated JSON and Markdown reports remain reviewable because they contain the benchmark conclusions and policy decisions. No generated snapshot file was observed in the capture, so snapshot patterns remain configurable and are not a Redline default.

Regenerate the report with:

```bash
mise run benchmark:review-eligibility
```

This measurement is one repository and one provider/model run. It supports the narrow Redline default; it is not evidence for globally excluding all benchmark or snapshot files.

## Log verbosity

`progress` is the normal dogfood setting. It retains:

- one start line per executed file;
- bounded, content-free harness diagnostic categories, capped at 16 lines per file;
- one model-stream chunk count at completion;
- one completion line with outcome and error kind.

`full-output` remains available for explicit diagnostics and retains its separate 32 KiB per-file live-output cap. Progress mode never prints harness diagnostic text, prompts, source, model text, reasoning, or credentials. `silent` keeps only file start and completion lines. Verbosity changes only live rendering: machine-readable process, token, retry, deadline, reuse, index, and publication telemetry remains in the review artifacts.
