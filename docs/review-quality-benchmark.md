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
| Prompt bytes (current v6 policy) | 46,183 | 47,222 | +1,039 |
| Resolved indexed source | 0 bytes | 216 bytes | +216 bytes |
| Recorded review duration | 39 ms | 39 ms | 0 ms |

The indexed recording recovers the cross-account cache collision and removes the false positive about an optional function argument. The file-local port defect remains detectable without indexed source.

## What the recorded comparison proves

The checked-in comparison verifies that:

- both modes use the same cases, review policy, model identity, and finding validator;
- file-only scores preserve the original expected-issue judgments; prompt bytes differ because the current v6 discovery policy adds bounded follow-up intents;
- indexed artifacts pass the production schema and identity checks;
- every injected span is re-resolved from captured exact-head source;
- context coverage, source bytes, prompt bytes, and timing fields remain reproducible;
- the scorer can expose an indexed-context quality change without hiding clean-change false positives.

It does **not** prove that CGC or a live model produces the checked-in relationships or findings reliably. Recorded responses are human-judged fixtures, and their durations are not production latency measurements. Workflow enablement requires separate live evidence.

## Scripted verifier replay (draft #107)

Run `pnpm run benchmark:verification` to replay the four v2 fixtures plus two additional cases: a defaulted-parameter false positive and a cross-file per-user throttle defect. `benchmark/review-quality/verification-v1/dispositions.json` contains **scripted**, manually selected verifier dispositions—not model responses. `report.json` retains the per-fixture discovery and post-verifier findings, credited issues, false positives, prompt bytes, coverage, and recorded durations. Run `node dist/src/benchmark/verification-cli.js --output /tmp/verification-report.json` after a build to regenerate a report without overwriting the checked-in evidence.

| Recorded mode | Credited issues before → after | False positives before → after | Recorded review duration before → after | Incomplete files |
| --- | ---: | ---: | ---: | ---: |
| File only | 1/3 → 1/3 | 2 → 0 | 63 → 113 ms | 0 |
| Indexed context | 3/3 → 3/3 | 0 → 0 | 63 → 125 ms | 0 |

The replay now also applies deterministic cross-file grouping and publication budgets after verification. All credited issues survive to the planned comments (file-only 1/3 and indexed 3/3), with zero post-plan false positives, zero duplicate comments, zero budget suppression, and complete planned coverage. This small corpus has **no duplicate or budget-saturated case**; unit and integration tests exercise those branches, but the recording does not establish their live prevalence or latency. The replay runs the production discovery parser, source validator, verifier prompt and citation validation. The scripted gate fails if any fixture loses a credited defect, gains a clean-change false positive, or ends with incomplete required coverage. It also records missing decisions as failures instead of silently skipping verification. The measured extra 50/62 ms is **fixture data**, not observed model latency. Scripted decisions were selected knowing the expected outcomes, so this pass proves the pipeline and scoring gates work, **not** independent verifier quality. Production activation remains blocked pending a separately judged live discovery-versus-verifier measurement on these cases and trusted-base Action verification on a subsequent PR. The GitHub Action and CLI still do not enable the opt-in verifier.

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

The historical checked-in live result (older discovery policy) is under `benchmark/review-quality/v2/live-model/`. Both modes found both expected defects with valid evidence and produced no findings on the clean fixtures. Indexed context added 1,039 prompt bytes and 216 resolved source bytes without changing recall, evidence accuracy, false positives, or duplicates. The single-run latency difference is not treated as an improvement because calls were sequential and provider latency varied.

## Opt-in independent verifier capture (draft #107)

After `pnpm run build`, `node dist/src/benchmark/live-verification-cli.js --output /tmp/redline-live-verification.json` requires `REDLINE_LIVE_BENCHMARK=1`, a Pi/OpenCode harness, and the same `REDLINE_MODEL_CONFIG`/`REDLINE_MODEL_AUTH` credentials as the live-model capture. The two-fixture verification extension and four-fixture v2 corpus are captured separately with `--corpus benchmark/review-quality/v2` for the latter (six fixtures total). Each mode runs discovery once, then **replays exactly that discovery output** to a fresh live verifier invocation for every candidate-bearing file. The private capture retains validated per-file discovery and verified records, source coverage, prompts, calls, verdict, and measured durations, but not raw model text or credentials. A separate human judgment must map findings to the predeclared expected issues and inspect false positives; the capture itself never auto-credits model claims. File-only and indexed modes use recorded context artifacts, not live provider queries. If a model requests action-owned follow-up without a live pinned provider, coverage is incomplete rather than silently assumed complete.

The activation gate requires no lost credited defects, no added clean-change false positives, adequate valid evidence, complete required coverage, and tolerable measured verifier latency. A single sequential provider run is directional evidence, not a stable latency distribution. The hardcoded Action gate remains off until the measurement and a trusted-base follow-up run pass.

The checked-in, independently judged live replay is at `benchmark/review-quality/verification-v1/live-model/`. On six fixtures across both modes, discovery credited **2/3 file-only** and **3/3 indexed** expected issues; the verifier retained **0/3 in both**. Clean-change false positives stayed zero, but five confirmed discovery defects were lost and six of twelve cases had incomplete required coverage. Five verifier calls took 189,538 ms in aggregate (observed p95 67,706 ms; a tiny sequential sample). The file-only port case was already omitted because discovery produced an invalid candidate. No live follow-up worker was configured, so requests for relationship evidence were explicitly incomplete. The live gate **failed**; no production activation or independent provider quality claim follows from the scripted replay. See `benchmark/review-quality/verification-v1/live-model/report.md` and run `pnpm run benchmark:judge-live-verification` to reproduce its scoring offline. These captures precede a later default-mode fail-closed change and cannot be treated as a pass for that revision.

A controlled verifier-v2 retest of the same five saved validated candidates confirmed **4/5** with exact source citations; the remaining file-only cache case was inconclusive. All five verifier documents parsed, including one standalone fenced JSON document. That retest had no discovery calls, clean controls, or provider queries, so it is **not** an activation gate pass. Details are in `benchmark/review-quality/verification-v1/live-model/verifier-v2-controlled.json` and the accompanying report.

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
