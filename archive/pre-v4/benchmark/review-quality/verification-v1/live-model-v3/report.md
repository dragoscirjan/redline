# Live verifier v3 evaluation

## Result

The production activation gate did not pass. Keep `CODE_INDEX_VERIFICATION_ENABLED` set to `false`.

The verifier retained every credited discovery finding and added no clean-change false positives. One indexed-context discovery document was invalid, so required review coverage was incomplete for `cross-file-cache-collision/indexed-context`. The verifier did not run for that case.

## Configuration

- Harness: Pi
- Provider: OpenRouter
- Model: `z-ai/glm-5.3-flash`
- Verifier policy: `redline-verification/v3`
- Capture dates: 2026-10-21
- Fixtures: six fixtures, each in file-only and indexed-context mode
- Independent judgments: 5

## Measurements

| Mode | Credited discovery → verified → published | Clean false positives before → after | Verifier calls | Verifier duration | Incomplete cases |
| --- | ---: | ---: | ---: | ---: | ---: |
| File only | 3 → 3 → 3 | 0 → 0 | 3 | 132,560 ms | 0 |
| Indexed context | 2 → 2 → 2 | 0 → 0 | 2 | 38,743 ms | 1 |

Observed verifier p95 was 76,496 ms. The activation threshold is 120,000 ms. This is one sequential provider capture, not a stable latency distribution.

## Changes validated by this capture

Verifier v3 retained source-proven defects when the changed function directly removed an input, guard, or namespace component. Review code accepted only citations that it re-resolved from:

- the reviewed file's captured base or head source;
- source-resolved indexed context supplied to the verifier;
- candidate evidence; or
- action-validated follow-up evidence.

The context bundle now captures base source for every reviewed non-added file. This lets verification re-resolve base-to-head evidence for ordinary modified files, not only deleted or renamed files.

## Blockers

- `cross-file-cache-collision/indexed-context` produced an invalid discovery candidate. Its `impactPath.limitation` failed schema validation. This left required coverage incomplete.
- The capture did not execute a live action-owned provider follow-up.
- The trusted-base GitHub Action publication check must occur on a subsequent pull request after activation code is merged.

The capture therefore supports the verifier v3 contract changes, but it does not authorize production activation.
