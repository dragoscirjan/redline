# v8 policy deterministic replay

These reports replay the existing checked-in responses and timings through the current validators and prompt assembler. They update prompt-volume accounting for `prompts/v8/`; they are not new live-model captures and cannot prove the new policy's recall, completion rate, or false-positive rate.

- `quality/`: original `benchmark/review-quality/v2` corpus.
- `performance/`: unchanged 20-file `benchmark/performance/v1` corpus/profile.
- `verification/`: existing scripted verification corpus/dispositions; activation remains false.

The default deterministic `benchmark:performance` command now writes `benchmark/policy-v8/performance`; CI checks that replay and protects the historical baseline from changes. Historical reports remain unchanged at their original locations. The performance timing inputs and earlier measured/simulated claims are not replaced by new live measurements.
