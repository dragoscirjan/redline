#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  RUNTIME="${SOURCE_RUNTIME:-node}"
  TMP="$(mktemp -d)"
  case "$RUNTIME" in
    node|bun) ;;
    *) printf 'unsupported source runtime: %s\n' "$RUNTIME" >&2; return 2 ;;
  esac
}

teardown() {
  rm -rf "$TMP"
}

@test "uses the pinned source runtime" {
  run "$RUNTIME" --version
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
  case "$RUNTIME" in
    node) [[ "$output" == v24.* ]] ;;
    bun) [ "$output" = '1.4.4' ] ;;
  esac
}

@test "runs deterministic benchmark entrypoints from TypeScript source" {
  run "$RUNTIME" "$ROOT/src/benchmark/cli.ts" \
    --output "$TMP/review-quality"
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
  [ -f "$TMP/review-quality/report.json" ]
  [ -f "$TMP/review-quality/report.md" ]

  run "$RUNTIME" "$ROOT/src/benchmark/performance-cli.ts" \
    --output "$TMP/performance"
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
  [ -f "$TMP/performance/report.json" ]
  [ -f "$TMP/performance/report.md" ]

  run "$RUNTIME" "$ROOT/src/benchmark/code-index-value-cli.ts" \
    --capture "$ROOT/benchmark/code-index-value/v1/capture.json" \
    --json "$TMP/code-index-value.json" \
    --markdown "$TMP/code-index-value.md"
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
  [ -f "$TMP/code-index-value.json" ]
  [ -f "$TMP/code-index-value.md" ]

  run "$RUNTIME" "$ROOT/src/benchmark/verification-cli.ts" \
    --output "$TMP/verification.json"
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
  [ -f "$TMP/verification.json" ]

  run "$RUNTIME" "$ROOT/src/benchmark/source-runtime-cli.ts" \
    --runtime "$RUNTIME" \
    --json "$TMP/source-runtime.json" \
    --markdown "$TMP/source-runtime.md"
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
  [ -f "$TMP/source-runtime.json" ]
  [ -f "$TMP/source-runtime.md" ]
}

@test "loads opt-in and installer entrypoints without emitted JavaScript" {
  run env -u REDLINE_LIVE_BENCHMARK "$RUNTIME" "$ROOT/src/benchmark/live-cli.ts" \
    --output "$TMP/live-model.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *'set REDLINE_LIVE_BENCHMARK=1'* ]]

  run env -u REDLINE_LIVE_BENCHMARK "$RUNTIME" "$ROOT/src/benchmark/performance-cli.ts" \
    --live --output "$TMP/live-performance"
  [ "$status" -eq 1 ]
  [[ "$output" == *'set REDLINE_LIVE_BENCHMARK=1'* ]]

  run env -u REDLINE_LIVE_BENCHMARK "$RUNTIME" "$ROOT/src/benchmark/live-verification-cli.ts" \
    --output "$TMP/live-verification.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *'set REDLINE_LIVE_BENCHMARK=1'* ]]

  run bash -c 'cd "$1" && "$2" "$3"' _ \
    "$TMP" "$RUNTIME" "$ROOT/src/benchmark/judge-live-verification.ts"
  [ "$status" -eq 1 ]
  [[ "$output" == *'redline-live-verification-judge:'* ]]

  run "$RUNTIME" "$ROOT/src/code-index/install-gitnexus.ts"
  [ "$status" -eq 2 ]
  [[ "$output" == *'destination must be an absolute path'* ]]
}
