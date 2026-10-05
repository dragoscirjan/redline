#!/usr/bin/env bash
# Runs one end-to-end review with the given harness (echo, pi, or opencode)
# against the local mock model endpoint. Used by the CI harness matrix and
# usable locally: bash test/harness-matrix-run.sh <harness>
set -euo pipefail

HARNESS="${1:?usage: harness-matrix-run.sh <echo|pi|opencode>}"
case "$HARNESS" in
  echo|pi|opencode) ;;
  *) printf 'unsupported harness: %s\n' "$HARNESS" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
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

# Mock model server on an ephemeral loopback port.
node "$ROOT/test/fixtures/mock-model-server.mjs" 0 > "$TMP/mock-port.json" &
MOCK_PID=$!
for _ in $(seq 1 50); do
  [[ -s "$TMP/mock-port.json" ]] && break
  sleep 0.1
done
PORT="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port))' "$TMP/mock-port.json")"
printf 'harness=%s mock-port=%s\n' "$HARNESS" "$PORT"

REDLINE_HARNESS="$HARNESS" \
REDLINE_REVIEW_DIR="$TMP/review" \
REDLINE_SOURCE_DIR="$TMP/source-at-head" \
REDLINE_OUTPUT_DIR="$TMP/output" \
REDLINE_MODEL_CONFIG="$(printf '{"provider":"mock","endpoint":"http://127.0.0.1:%s/v1","model":"test-model"}' "$PORT")" \
REDLINE_MODEL_AUTH='{"mock":"test-key"}' \
REDLINE_TIMEOUT=10m \
node "$ROOT/dist/src/review/cli.js"

# Assert the review completed clean for the single fixture file.
node - "$HARNESS" "$TMP/output/reviews/summary.json" <<'NODE'
const fs = require('fs');
const harness = process.argv[2];
const summary = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const failures = [];
if (summary.harness !== harness) failures.push(`harness=${summary.harness} expected=${harness}`);
if (summary.reviewedFiles !== 1) failures.push(`reviewedFiles=${summary.reviewedFiles}`);
if (summary.omittedFiles !== 0) failures.push(`omittedFiles=${summary.omittedFiles}`);
if (summary.findings !== 0) failures.push(`findings=${summary.findings}`);
const file = summary.files[0];
if (!file || file.outcome !== 'clean') failures.push(`file outcome=${file && file.outcome}`);
if (failures.length > 0) {
  console.error(`harness matrix assertion failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`harness matrix ok: ${harness} reviewed ${summary.reviewedFiles} file clean`);
NODE
head -8 "$TMP/output/reviews/summary.md"
