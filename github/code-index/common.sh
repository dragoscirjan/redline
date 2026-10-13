#!/usr/bin/env bash

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
REPOSITORY_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
readonly REPOSITORY_ROOT
readonly RUNTIME_ROOT="${RUNNER_TEMP:?RUNNER_TEMP is required}/redline-code-index"
readonly CONTROL_DIR="$RUNTIME_ROOT/control"
readonly CACHE_ROOT="$RUNTIME_ROOT/cache"
readonly SOURCE_ROOT="$RUNTIME_ROOT/source"
readonly HEAD_SOURCE_ROOT="$RUNTIME_ROOT/head-source"
readonly PROVIDER_HOME="$RUNTIME_ROOT/home"
readonly TOOL_ROOT="$RUNTIME_ROOT/tool"

write_output() {
  local key=$1 value=$2
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

write_control() {
  local name=$1 value=$2
  printf '%s' "$value" > "$CONTROL_DIR/$name"
}

read_control() {
  local name=$1
  [[ -f "$CONTROL_DIR/$name" ]] || return 1
  IFS= read -r value < "$CONTROL_DIR/$name" || [[ -n "${value:-}" ]]
  printf '%s' "${value:-}"
}

now_ns() {
  python3 - <<'PY'
import time
print(time.monotonic_ns())
PY
}

elapsed_ms() {
  python3 - "$1" <<'PY'
import sys, time
started = int(sys.argv[1])
print(max(0, (time.monotonic_ns() - started) // 1_000_000))
PY
}

initialize_artifact() {
  local provider=$1 provider_version=$2 status=$3 code=$4 message=$5 installation_ms=$6
  python3 "$SCRIPT_DIR/export.py" initialize \
    --provider "$provider" \
    --provider-version "$provider_version" \
    --base "${REDLINE_CODE_INDEX_BASE}" \
    --head "${REDLINE_CODE_INDEX_HEAD}" \
    --repository "${REDLINE_CODE_INDEX_REPOSITORY}" \
    --output-directory "${REDLINE_CODE_INDEX_OUTPUT_DIRECTORY}" \
    --workspace "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}" \
    --status "$status" \
    --diagnostic-code "$code" \
    --diagnostic-message "$message" \
    --installation-ms "$installation_ms"
}

write_build_output() {
  local build_result="$CONTROL_DIR/build-result.json" cache_ready
  cache_ready=$(python3 - "$build_result" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    print('true' if json.load(handle).get('cacheReady') is True else 'false')
PY
)
  write_output cache-ready "$cache_ready"
}

save_start() {
  mkdir -p -- "$CONTROL_DIR"
  write_control save-start-ns "$(now_ns)"
}

finalize() {
  local save_ms='null' save_outcome cache_hit context_file status
  save_outcome=${REDLINE_CODE_INDEX_CACHE_SAVE_OUTCOME:-skipped}
  if [[ -f "$CONTROL_DIR/save-start-ns" ]]; then
    save_ms=$(elapsed_ms "$(read_control save-start-ns)")
  fi
  python3 "$SCRIPT_DIR/export.py" finalize \
    --output-directory "${REDLINE_CODE_INDEX_OUTPUT_DIRECTORY}" \
    --save-ms "$save_ms" \
    --save-outcome "$save_outcome" \
    || return $?

  context_file=$(python3 -c 'import os,sys; print(os.path.realpath(os.path.join(sys.argv[1], "code-context.json")))' \
    "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY")
  status=$(python3 - "$context_file" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    print(json.load(handle)['status'])
PY
)
  cache_hit=false
  [[ -n "${REDLINE_CODE_INDEX_CACHE_MATCHED_KEY:-}" ]] && cache_hit=true
  write_output context-file "$context_file"
  write_output status "$status"
  write_output cache-hit "$cache_hit"
}
