# Read the results

Start with coverage, then inspect findings. A model can return no findings while some required files were never reviewed.

## 1. Check coverage

The terminal reports how many required files completed, failed, or were inert. It also reports reused results and retry recovery when applicable.

- Completed files have validated review records.
- Failed or omitted required files make the review incomplete.
- Excluded files, such as lock files or binary files, are recorded but are not reviewed.

Missing or partial related context is reported separately. It is not evidence that the change has no callers or tests.

## 2. Read findings before applying anything

Findings include a location, severity, classification and explanation. They may include a suggested change and a fix prompt.

Redline validates result structure and authoritative diff evidence. That does not prove the model's diagnosis is correct. Check the code and the claimed impact before applying a suggestion. Redline does not apply it for you.

The `echo` harness always supplies a clean answer. Its result demonstrates integration, not review quality.

## 3. Open the saved review

Use the artifact path printed at the end of the run. By default it is a new directory below `$XDG_STATE_HOME/redline/reviews/`, or `$HOME/.local/state/redline/reviews/`.

Inside that run directory:

| File or directory | Use it for |
| --- | --- |
| `reviews/review.md` | Read the consolidated review |
| `reviews/summary.json` | Inspect run coverage, outcomes and telemetry |
| `reviews/*.json` | Inspect per-file records and the consolidated JSON review |
| `capture.json` | Check the exact revisions and captured working state |
| `status.json` | Check completion, failure, cancellation or deadline status |
| `bundle/` and `source/` | Inspect the authoritative change and captured source |

Every run gets a new directory. To choose a path, see [Save output](/commands#save-output-to-a-chosen-directory). Interrupted runs can retain partial artifacts; do not treat them as completed reviews.

## 4. Interpret the exit code

| Code | Meaning |
| --- | --- |
| `0` | The run completed without meeting a selected failure policy. It can still contain findings. |
| `1` | An operational problem or incomplete required review |
| `2` | An invalid argument or configuration |
| `3` | Findings met the selected `--fail-on` threshold |
| `130` | Cancellation |

For example, `--fail-on high` fails on high or critical findings. Incomplete required coverage fails regardless of that threshold.

For capability and reporter exit codes, see the [complete exit-status reference](/local-cli#output-and-exit-status). For JSON fields and publication records, see the [output schema](/review-reporting).
