#!/usr/bin/env bash
# Runs one end-to-end review with the given harness (echo, pi, or opencode)
# against the local mock model endpoint. Used by the CI harness matrix and
# usable locally: bash test/harness-matrix-run.sh <harness>
#
# The review output is written to $HARNESS_MATRIX_OUTPUT_DIR when set (used
# by CI to upload the per-harness review artifact); otherwise it stays inside
# the throwaway fixture directory. The echo harness answers clean; pi and
# opencode are served a scripted finding document so the run demonstrates
# real validated findings end to end.
set -euo pipefail

HARNESS="${1:?usage: harness-matrix-run.sh <echo|pi|opencode>}"
case "$HARNESS" in
  echo|pi|opencode) ;;
  *) printf 'unsupported harness: %s\n' "$HARNESS" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
OUTPUT_DIR="${HARNESS_MATRIX_OUTPUT_DIR:-$TMP/output}"
mkdir -p "$OUTPUT_DIR"
MOCK_PID=""

cleanup() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if [[ "$HARNESS" != "echo" ]]; then
  command -v "$HARNESS" >/dev/null 2>&1 || {
    printf 'harness %s is not on PATH\n' "$HARNESS" >&2
    exit 2
  }
fi

# Fixture repository with one modified text file.
REPO="$TMP/repo"
mkdir -p "$REPO/src"
git -C "$REPO" init -q
git -C "$REPO" config user.name Test
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config core.autocrlf false
printf 'old\n' > "$REPO/src/example.ts"
git -C "$REPO" add .
git -C "$REPO" commit -qm base
BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"
printf 'new\n' > "$REPO/src/example.ts"
git -C "$REPO" add .
git -C "$REPO" commit -qm head
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"

# context-bundle.sh operates on the git checkout it runs in.
git -C "$REPO" worktree add --detach "$TMP/source" "$HEAD_SHA" >/dev/null 2>&1
(
  cd "$TMP/source"
  bash "$ROOT/src/context-bundle.sh" \
    --base "$BASE_SHA" \
    --head "$HEAD_SHA" \
    --output "$TMP/review" \
    --source "$TMP/source-at-head"
)

PORT=""
if [[ "$HARNESS" != "echo" ]]; then
  # Scripted finding document for the fixture diff: RIGHT span 1-1 is "new".
  # The runner must accept it through schema and diff-evidence validation,
  # derive a change suggestion from the proposed replacement, and attach a
  # fix prompt for a coding agent.
  MOCK_RESPONSE_TEXT='{"version":2,"fileId":"000001","outcome":"findings","findings":[{"category":"correctness","classification":"defect","severity":"high","confidence":0.9,"side":"RIGHT","startLine":1,"endLine":1,"evidence":"new","impact":"The changed line breaks the fixture contract for this review.","fix":"Restore the previous value or update the contract.","suggestedChange":"old"}]}' \
    node "$ROOT/test/fixtures/mock-model-server.mjs" 0 > "$TMP/mock-port.json" &
  MOCK_PID=$!
  for _ in $(seq 1 50); do
    [[ -s "$TMP/mock-port.json" ]] && break
    sleep 0.1
  done
  PORT="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port))' "$TMP/mock-port.json")"
fi
printf 'harness=%s mock-port=%s output=%s\n' "$HARNESS" "${PORT:-n/a}" "$OUTPUT_DIR"

MODEL_CONFIG='{"provider":"mock","endpoint":"http://127.0.0.1:1/v1","model":"test-model"}'
if [[ -n "$PORT" ]]; then
  MODEL_CONFIG="$(printf '{"provider":"mock","endpoint":"http://127.0.0.1:%s/v1","model":"test-model"}' "$PORT")"
fi

REDLINE_HARNESS="$HARNESS" \
REDLINE_REVIEW_DIR="$TMP/review" \
REDLINE_SOURCE_DIR="$TMP/source-at-head" \
REDLINE_OUTPUT_DIR="$OUTPUT_DIR" \
REDLINE_MODEL_CONFIG="$MODEL_CONFIG" \
REDLINE_MODEL_AUTH='{"mock":"test-key"}' \
REDLINE_TIMEOUT=10m \
node "$ROOT/dist/src/review/cli.js"

# Assert the review outcome for the single fixture file. Echo is the
# deterministic clean harness; pi and opencode must produce the scripted,
# diff-validated finding.
node - "$HARNESS" "$OUTPUT_DIR/reviews/summary.json" "$OUTPUT_DIR/reviews/000001.json" <<'NODE'
const fs = require('fs');
const harness = process.argv[2];
const summary = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const record = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const expectFindings = harness !== 'echo';
const expectedOutcome = expectFindings ? 'findings' : 'clean';
const failures = [];
if (summary.harness !== harness) failures.push(`harness=${summary.harness} expected=${harness}`);
if (summary.reviewedFiles !== 1) failures.push(`reviewedFiles=${summary.reviewedFiles}`);
if (summary.omittedFiles !== 0) failures.push(`omittedFiles=${summary.omittedFiles}`);
const expectedFindingCount = expectFindings ? 1 : 0;
if (summary.findings !== expectedFindingCount) failures.push(`findings=${summary.findings} expected=${expectedFindingCount}`);
const file = summary.files[0];
if (!file || file.outcome !== expectedOutcome) failures.push(`file outcome=${file && file.outcome} expected=${expectedOutcome}`);
if (record.outcome !== expectedOutcome) failures.push(`record outcome=${record.outcome} expected=${expectedOutcome}`);
if (expectFindings) {
  const finding = record.findings && record.findings[0];
  if (!finding) {
    failures.push('finding missing from record');
  } else {
    if (!/^f-[0-9a-f]{24}$/u.test(finding.id)) failures.push(`finding id=${finding.id} is not a stable id`);
    if (finding.side !== 'RIGHT' || finding.startLine !== 1 || finding.endLine !== 1 || finding.evidence !== 'new') {
      failures.push(`finding mapping=${finding.side}:${finding.startLine}-${finding.endLine} "${finding.evidence}" is not RIGHT:1-1 "new"`);
    }
    if (finding.suggestion !== '-new\n+old') {
      failures.push(`suggestion=${JSON.stringify(finding.suggestion)} is not the diff-anchored -new/+old change`);
    }
    if (typeof finding.fixPrompt !== 'string' || !finding.fixPrompt.includes('Fix one code-review finding.') || !finding.fixPrompt.includes('src/example.ts:1')) {
      failures.push('fixPrompt is missing or does not cite the file span');
    }
  }
}
if (failures.length > 0) {
  console.error(`harness matrix assertion failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`harness matrix ok: ${harness} reviewed ${summary.reviewedFiles} file, outcome ${expectedOutcome}, findings ${summary.findings}`);
NODE
head -12 "$OUTPUT_DIR/reviews/summary.md"
