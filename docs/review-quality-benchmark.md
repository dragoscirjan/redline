# Review-quality benchmark

Redline uses a versioned fixture corpus to measure review behavior before adding code indexing or more review stages.

The first corpus lives under `benchmark/review-quality/v1/`. It contains two known-defect cases and two clean cases. Each fixture includes its base and head source, authoritative diff, expected defects, acceptable evidence locations, recorded review response, and human judgment linking each recorded finding to an expected defect or false positive.

## Run the recorded benchmark

```bash
mise run benchmark
```

The command rebuilds Redline, runs every recorded response through the real review parser and finding validator, scores the validated records, and writes:

- `benchmark/review-quality/v1/baseline/report.json`
- `benchmark/review-quality/v1/baseline/report.md`

The command performs no network requests and starts no model or indexer.

## Measurements

The report keeps raw counts for:

- expected and detected root causes;
- validated findings and false positives;
- clean fixtures that received a false positive;
- claimed root-cause matches with valid evidence locations;
- total system and user prompt bytes;
- recorded review duration;
- complete, partial, or unavailable review coverage.

A finding receives root-cause credit only when a human judgment associates it with an expected defect and its validated span falls within an accepted evidence location. Text similarity does not grant credit.

## What the baseline proves

Root-cause matching, evidence accuracy, false positives, and duplicate findings are separate measurements. A root-cause match with an unacceptable evidence span lowers credited recall and evidence accuracy, but it is not counted again as a false positive.

The checked-in baseline verifies that:

- fixtures can run through the current file-only review pipeline;
- review output still passes the production parser and diff validator;
- root-cause, evidence, and false-positive scoring is deterministic;
- report JSON and Markdown are reproducible;
- later file-only and indexed-context recordings can use the same cases and scorer.

The baseline does not measure a live model, provider quality, or production latency. Recorded durations are fixture data. Live model and indexer runs remain opt-in and must be reported separately.

## Adding a fixture

Add the fixture JSON under `benchmark/review-quality/v1/fixtures/` and list it in `corpus.json`. A defect fixture must declare at least one expected issue and accepted evidence location. A clean fixture cannot declare an expected issue. Every recorded finding needs an explicit judgment.

Keep fixture source small enough to inspect directly. Include both defect and clean cases when extending a defect category so recall cannot improve by hiding false positives.

## Adding indexed context

Issue #110 will add a `github/code-index` action. Benchmark schema version 1 accepts only `file-only` recordings. Add an `indexed-context` mode only when #110 supplies the real indexed prompt path and its byte measurement. Do not change expected issues, accepted evidence locations, or file-only recordings when comparing the modes.
