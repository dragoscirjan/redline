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
| Prompt bytes (v7 policy) | 47,647 | 48,686 | +1,039 |
| Resolved indexed source | 0 bytes | 216 bytes | +216 bytes |
| Recorded review duration | 39 ms | 39 ms | 0 ms |

The indexed recording recovers the cross-account cache collision and removes the false positive about an optional function argument. The file-local port defect remains detectable without indexed source.

## What the recorded comparison proves

The checked-in comparison verifies that:

- both modes use the same cases, review policy, model identity, and finding validator;
- file-only scores preserve the original expected-issue judgments; prompt bytes reflect the v7 policy's explicit trusted follow-up capability, while older v6 live captures remain historical evidence;
- indexed artifacts pass the production schema and identity checks;
- every injected span is re-resolved from captured exact-head source;
- context coverage, source bytes, prompt bytes, and timing fields remain reproducible;
- the scorer can expose an indexed-context quality change without hiding clean-change false positives.

It does **not** prove that CGC or a live model produces the checked-in relationships or findings reliably. Recorded responses are human-judged fixtures, and their durations are not production latency measurements. Workflow enablement requires separate live evidence.

## Scripted verifier replay (draft #107)

Run `pnpm run benchmark:verification` to replay the four v2 fixtures plus two additional cases: a defaulted-parameter false positive and a cross-file per-user throttle defect. `benchmark/review-quality/verification-v1/dispositions.json` contains **scripted**, manually selected verifier dispositions—not model responses. `report.json` retains the per-fixture discovery and post-verifier findings, credited issues, false positives, prompt bytes (regenerated under the v7 policy), coverage, and recorded durations. Run `node dist/src/benchmark/verification-cli.js --output /tmp/verification-report.json` after a build to regenerate a report without overwriting the checked-in evidence.

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

The checked-in, independently judged live replay is at `benchmark/review-quality/verification-v1/live-model/`. On six fixtures across both modes, discovery credited **2/3 file-only** and **3/3 indexed** expected issues; the verifier retained **0/3 in both**. Clean-change false positives stayed zero, but five confirmed discovery defects were lost and six of twelve cases had incomplete required coverage. Five verifier calls took 189,538 ms in aggregate (observed p95 67,706 ms; a tiny sequential sample). The file-only port case was already omitted because discovery produced an invalid candidate. No live follow-up worker was configured, so requests for relationship evidence were explicitly incomplete. The live gate **failed**; no production activation or independent provider quality claim follows from the scripted replay. See `benchmark/review-quality/verification-v1/live-model/report.md` and run `pnpm run benchmark:judge-live-verification` to reproduce its scoring offline. These captures precede the v7 capability-aware discovery policy and a later default-mode fail-closed change; they cannot establish a pass for either revision.

A controlled verifier-v2 retest of the same five saved validated candidates confirmed **4/5** with exact source citations; the remaining file-only cache case was inconclusive. All five verifier documents parsed, including one standalone fenced JSON document. That retest had no discovery calls, clean controls, or provider queries, so it is **not** an activation gate pass. Details are in `benchmark/review-quality/verification-v1/live-model/verifier-v2-controlled.json` and the accompanying report.

The current verifier-v3 capture is under `benchmark/review-quality/verification-v1/live-model-v3/`. It covers all six fixtures in both modes with Pi, OpenRouter, and `z-ai/glm-5.3-flash`. Verification retained every credited discovery finding: file-only recall stayed 3/3 and indexed-context recall stayed 2/3, with no clean-change false positives. Observed verifier p95 was 76,496 ms. The gate still failed because the indexed cache fixture produced an invalid discovery candidate before verification, which left one required-coverage case incomplete. No live action-owned provider follow-up ran in that model capture. The Action gate therefore remains off. `report.json` contains the machine-scored result; `report.md` records the judgment and limitations.

A separate action-owned follow-up benchmark is under `benchmark/review-quality/follow-up-v1/live-providers/`. Both pinned providers returned the expected source-confirmed incoming span in five sequential queries. The no-index control made zero provider calls and recorded required incomplete coverage. This proves the provider execution path, but it does not repair the incomplete verifier-v3 case or replace a trusted-base end-to-end model capture.

## Opt-in live-indexer evaluation

With the pinned CGC 0.5.7 binary installed on `PATH`, run:

```bash
mise run benchmark:live-indexer
```

This exercises the production `github/code-index` path against the cross-file cache fixture and requires the expected related span. It prints the live artifact and exits non-zero when the relationship is missing. It does not call a model. Normal CI continues to use fake provider behavior and does not download CGC.

The checked-in live result is under `benchmark/review-quality/v2/live-indexer/`. In the measured cold run, CGC 0.5.7 returned complete coverage and the expected source-confirmed caller. Installation took 1,837 ms, restore bookkeeping 40 ms, indexing 7,825 ms, and bounded queries 18,048 ms. The prior partial result was a Redline host defect: its stdout limit also restricted CGC's embedded database writes.

## Code-index provider value comparison

Run the deterministic report generator with:

```bash
mise run benchmark:code-index-value
```

The checked-in capture and generated reports are under `benchmark/code-index-value/v1/`. They compare cold and validated exact-base warm paths for CGC 0.5.7 and GitNexus 1.6.12 on the two-file TypeScript fixture and the Redline repository. The report keeps p50 and nearest-rank p95 installation, restore, validation, index, relationship-query, wall-time, and cache-size measurements. It also includes three GitHub-hosted default-branch warmups per provider, bounded follow-up latency, provider failures, prompt and source-byte cost, review-quality evidence, and licensing.

Current measurements do not justify a default-provider change. GitNexus was faster and returned complete related spans, but its PolyForm Noncommercial 1.0.0 license is not suitable as an unconditional default. CGC remained partial with zero spans in the current local captures. The historical live-model comparison showed no review-quality gain, so provider speed does not enable verification or follow-up publication.

## Evidence and subsequent enablement

The live production indexer now supplies the expected related caller, so provider capability is demonstrated for this fixture. The comparison still does not show a review-quality gain: the live model found every expected defect without the related source, and the indexed recording did not improve measured recall or precision. The measured path adds installation, indexing, query, prompt-size, and cache complexity.

After that measurement, the owner chose to continue the indexing investment and make the published Redline action invoke its bundled index action by default. This product direction does not reinterpret the benchmark or claim a quality improvement. File-only review remains available through `indexing: disabled`, and unavailable generated context still degrades to file-only review with recorded coverage.

Redline must repeat the model-quality evaluation with complete action-owned follow-up coverage before it claims an indexed-context quality benefit or enables verifier-driven publication. Provider capability alone does not satisfy that gate.

## Adding a fixture

Add the fixture JSON under `benchmark/review-quality/v2/fixtures/` and list it in `corpus.json`. A defect fixture must declare at least one expected issue and accepted evidence location. A clean fixture cannot declare an expected issue. Every recorded finding needs an explicit judgment.

Each fixture must contain one `file-only` and one `indexed-context` recording. The indexed recording embeds the exact compact artifact consumed by production review. Keep fixture source small enough to inspect directly and add both defect and clean cases when extending a defect category.
