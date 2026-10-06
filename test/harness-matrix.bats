#!/usr/bin/env bats

# Self-test for the CI harness matrix runner script. The pi and opencode
# entries need their binaries on PATH; the echo entry runs everywhere and
# verifies the script's output-directory contract that the CI artifact
# upload depends on.

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  CLI="$ROOT/dist/src/review/cli.js"
  TMP="$(mktemp -d)"
  OUTPUT="$TMP/harness-reviews"
}

teardown() {
  rm -rf "$TMP"
}

@test "requires a prior build of the CLI" {
  [ -f "$CLI" ]
}

@test "rejects an unsupported harness" {
  run bash "$ROOT/test/harness-matrix-run.sh" claude
  [ "$status" -eq 2 ]
  [[ "$output" == *"unsupported harness: claude"* ]]
}

@test "echo run writes its review records to the override output directory" {
  HARNESS_MATRIX_OUTPUT_DIR="$OUTPUT" run bash "$ROOT/test/harness-matrix-run.sh" echo
  [ "$status" -eq 0 ]
  [[ "$output" == *"harness matrix ok: echo reviewed 1 file, outcome clean, findings 0"* ]]
  # The CI artifact upload uses if-no-files-found: error; the same files must
  # exist for every harness, echo included.
  [ -f "$OUTPUT/reviews/000001.json" ]
  [ -f "$OUTPUT/reviews/000001.md" ]
  [ -f "$OUTPUT/reviews/summary.json" ]
  [ -f "$OUTPUT/reviews/summary.md" ]
  grep -Fq '"outcome": "clean"' "$OUTPUT/reviews/000001.json"
  grep -Fq '"harness": "echo"' "$OUTPUT/reviews/summary.json"
}

@test "echo run does not depend on a mock model endpoint" {
  # The echo harness never contacts the endpoint: a dead loopback port in the
  # model config must not affect its outcome.
  HARNESS_MATRIX_OUTPUT_DIR="$OUTPUT" run bash "$ROOT/test/harness-matrix-run.sh" echo
  [ "$status" -eq 0 ]
  [[ "$output" == *"mock-port=n/a"* ]]
}

@test "ci matrix wires the output directory and uploads per-harness artifacts" {
  run python3 - "$ROOT" <<'PY'
import re
from pathlib import Path
import sys

root = Path(sys.argv[1])
ci = (root / '.github/workflows/ci.yml').read_text()
assert 'HARNESS_MATRIX_OUTPUT_DIR: ${{ runner.temp }}/harness-reviews' in ci, \
    'matrix jobs must redirect the review output out of the throwaway fixture'
assert re.search(r'name: harness-\$\{\{ matrix\.harness \}\}-reviews-', ci), \
    'matrix jobs must upload a per-harness review artifact'
assert 'if-no-files-found: error' in ci, 'matrix artifact upload must fail when empty'
assert 'actions/upload-artifact@' in ci and '# v7.0.1' in ci, \
    'upload-artifact must stay version-pinned by SHA'

script = (root / 'test/harness-matrix-run.sh').read_text()
assert 'MOCK_RESPONSE_TEXT=' in script, \
    'pi/opencode entries must demonstrate a validated finding, not only clean runs'
assert 'expectFindings' in script or 'findings' in script, \
    'matrix assertions must cover the finding path'
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}
