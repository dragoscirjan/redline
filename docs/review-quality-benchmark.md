# Review-quality benchmark

Redline uses a versioned fixture corpus to compare review behavior before enabling code indexing or adding more review stages.

The historical file-only baseline remains under `benchmark/review-quality/v1/`. The comparison corpus under `benchmark/review-quality/v2/` preserves the same four diffs, expected issues, acceptable evidence locations, and file-only recordings. It adds one `indexed-context` recording and one strict provider-neutral `code-context` artifact fixture per case. These artifacts model bounded provider output; the separate live-indexer run determines whether CGC produces it.

## Run the recorded comparison

```bash
mise run benchmark
```

The command rebuilds Redline, runs both modes through the production review parser, indexed-context loader, exact-head source resolver, prompt builder, and finding validator, then writes:

- `benchmark/review-quality/v2/comparison/report.json`
- `benchmark/review-quality/v2/comparison/report.md`

The command performs no network requests and starts no model or indexer. The checked-in artifacts, responses, durations, and zero-valued index timings are fixture data.

## Measurements

The report keeps raw counts for:

- expected and detected root causes;
- validated findings, credited issues, false positives, and duplicates;
- clean fixtures that received a false positive;
- claimed matches with valid evidence locations;
- review coverage and indexed-context coverage;
- resolved related spans and source bytes;
- total system and user prompt bytes;
- recorded review duration;
- recorded installation, restore, indexing, query, and save timings when present.

A finding receives credit only when a human judgment associates it with an expected defect and its validated span falls within an accepted evidence location. Indexed source cannot provide the published finding location.

## Checked-in result

| Measurement | File only | Indexed context | Delta |
| --- | ---: | ---: | ---: |
| Root-cause recall | 1/2 | 2/2 | +1 |
| Credited issue recall | 1/2 | 2/2 | +1 |
| False positives | 1 | 0 | -1 |
| Duplicate findings | 0 | 0 | 0 |
| Prompt bytes | 31,707 | 32,746 | +1,039 |
| Resolved indexed source | 0 bytes | 216 bytes | +216 bytes |
| Recorded review duration | 39 ms | 39 ms | 0 ms |

The indexed recording recovers the cross-account cache collision and removes the false positive about an optional function argument. The file-local port defect remains detectable without indexed source.

## What the recorded comparison proves

The checked-in comparison verifies that:

- both modes use the same cases, review policy, model identity, and finding validator;
- file-only prompts and scores remain identical to the v1 baseline;
- indexed artifacts pass the production schema and identity checks;
- every injected span is re-resolved from captured exact-head source;
- context coverage, source bytes, prompt bytes, and timing fields remain reproducible;
- the scorer can expose an indexed-context quality change without hiding clean-change false positives.

It does **not** prove that CGC or a live model produces the checked-in relationships or findings reliably. Recorded responses are human-judged fixtures, and their durations are not production latency measurements. Workflow enablement requires separate live evidence.

## Scripted verifier replay (draft #107)

Run `pnpm run benchmark:verification` to replay the four v2 fixtures plus two additional cases: a defaulted-parameter false positive and a cross-file per-user throttle defect. `benchmark/review-quality/verification-v1/dispositions.json` contains **scripted**, manually selected verifier dispositions—not model responses. `report.json` retains the per-fixture discovery and post-verifier findings, credited issues, false positives, prompt bytes, coverage, and recorded durations. Run `pnpm run benchmark:verification -- --output /tmp/verification-report.json` to regenerate a report without overwriting the checked-in evidence.

| Recorded mode | Credited issues before → after | False positives before → after | Recorded review duration before → after | Incomplete files |
| --- | ---: | ---: | ---: | ---: |
| File only | 1/3 → 1/3 | 2 → 0 | 63 → 113 ms | 0 |
| Indexed context | 3/3 → 3/3 | 0 → 0 | 63 → 125 ms | 0 |

The replay runs the production discovery parser, source validator, verifier prompt and citation validation. The scripted gate fails if any fixture loses a credited defect, gains a clean-change false positive, or ends with incomplete required coverage. It also records missing decisions as failures instead of silently skipping verification. The measured extra 50/62 ms is **fixture data**, not observed model latency. Scripted decisions were selected knowing the expected outcomes, so this pass proves the pipeline and scoring gates work, **not** independent verifier quality. Production activation remains blocked pending a separately judged live discovery-versus-verifier measurement on these cases and trusted-base Action verification on a subsequent PR. The GitHub Action and CLI still do not enable the opt-in verifier.

## Opt-in live-model capture

A live capture runs the same corpus and model configuration through Pi or OpenCode. It uses the checked-in context artifacts so model behavior can be measured independently from provider variability.

```bash
REDLINE_LIVE_BENCHMARK=1 \
REDLINE_HARNESS=pi \
REDLINE_MODEL_CONFIG='{"provider":"openrouter","endpoint":"https://openrouter.ai/api/v1","model":"..."}' \
REDLINE_MODEL_AUTH='{"openrouter":"..."}' \
mise run benchmark:live-model -- --output /tmp/redline-live-model.json
```

The output contains validated per-file records, prompt bytes, context coverage, and measured review duration for both modes. It intentionally does not assign findings to expected issues automatically; a reviewer must judge new findings before promoting them into the deterministic corpus. The capture is written with owner-only permissions and never includes the selected credential or endpoint.

The checked-in live result is under `benchmark/review-quality/v2/live-model/`. Both modes found both expected defects with valid evidence and produced no findings on the clean fixtures. Indexed context added 1,039 prompt bytes and 216 resolved source bytes without changing recall, evidence accuracy, false positives, or duplicates. The single-run latency difference is not treated as an improvement because calls were sequential and provider latency varied.

## Opt-in live-indexer evaluation

With the pinned CGC 0.5.7 binary installed on `PATH`, run:

```bash
mise run benchmark:live-indexer
```

This exercises the production `github/code-index` path against the cross-file cache fixture and requires the expected related span. It prints the live artifact and exits non-zero when the relationship is missing. It does not call a model. Normal CI continues to use fake provider behavior and does not download CGC.

The checked-in live result is under `benchmark/review-quality/v2/live-indexer/`. In the measured cold run, CGC 0.5.7 indexed the fixture but returned partial coverage with no related span because the incoming relationship query failed. Installation took 2,036 ms, restore bookkeeping 67 ms, indexing 8,023 ms, and bounded queries 18,063 ms. Save was not attempted after the failed assertion.

## Evidence and subsequent enablement

This comparison did not provide evidence for enabling `github/code-index`. The deterministic recordings show an upper-bound benefit when useful related source is supplied, but the live model already found every expected defect without that source. Indexed context did not improve measured quality. More importantly, the live production indexer returned partial coverage and no related caller for the cross-file fixture. The measured path added installation, indexing, query, prompt-size, and cache complexity without a demonstrated review-quality gain.

After that measurement, the owner chose to continue the indexing investment and make the published Redline action invoke its bundled index action by default. This product direction does not reinterpret the benchmark or claim a quality improvement. File-only review remains available through `indexing: disabled`, and unavailable generated context still degrades to file-only review with recorded coverage.

A provider or query change must recover the expected live relationship and repeat both live evaluations before Redline claims an indexed-context quality benefit. The current result still does not justify a second provider, base index, graph delta, dynamic review query, or full impact planner.

## Adding a fixture

Add the fixture JSON under `benchmark/review-quality/v2/fixtures/` and list it in `corpus.json`. A defect fixture must declare at least one expected issue and accepted evidence location. A clean fixture cannot declare an expected issue. Every recorded finding needs an explicit judgment.

Each fixture must contain one `file-only` and one `indexed-context` recording. The indexed recording embeds the exact compact artifact consumed by production review. Keep fixture source small enough to inspect directly and add both defect and clean cases when extending a defect category.
