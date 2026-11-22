#!/usr/bin/env bats

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  cd "$BATS_TEST_TMPDIR" || return 1
}

@test "help identifies review execution as unavailable" {
  run env REDLINE_ENV=bun bun "$PROJECT_ROOT/bin/redline.mjs" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Review execution is not implemented."* ]]
}

@test "JSON status distinguishes available and unimplemented capabilities" {
  run env REDLINE_ENV=bun bun "$PROJECT_ROOT/bin/redline.mjs" status --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"phase":"scaffold"'* ]]
  [[ "$output" == *'"review":"not-implemented"'* ]]
  [[ "$output" == *'"publication":"not-implemented"'* ]]
}

@test "review fails explicitly instead of invoking archived code" {
  run env REDLINE_ENV=bun bun "$PROJECT_ROOT/bin/redline.mjs" review
  [ "$status" -eq 2 ]
  [[ "$output" == *"review execution is not implemented in the Initiative 4.0 scaffold"* ]]
}

@test "RPC fails explicitly rather than pretending to start a server" {
  run env REDLINE_ENV=bun bun "$PROJECT_ROOT/bin/redline.mjs" rpc
  [ "$status" -eq 2 ]
  [[ "$output" == *"rpc execution is not implemented in the Initiative 4.0 scaffold"* ]]
}

@test "the legacy review executable also rejects execution" {
  run env REDLINE_ENV=bun bun "$PROJECT_ROOT/bin/redline-review.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *"review execution is not implemented in the Initiative 4.0 scaffold"* ]]
}
