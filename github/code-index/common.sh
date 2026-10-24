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
  local save_ms='null' save_outcome context_file metrics cache_hit index_ms duration_ms cache_size status warmup_result
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
  metrics=$(python3 - "$context_file" "$CACHE_ROOT" <<'PY'
import json
import os
from pathlib import Path
import sys

artifact = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
timings = artifact['timings']
cache_hit = any(item.get('code') == 'cache-base-revision' for item in artifact['diagnostics'])
duration = sum(value for value in timings.values() if isinstance(value, int))
size = 0
entries = 0
root = Path(sys.argv[2])
try:
    if root.exists() and not root.is_symlink():
        for current, directories, files in os.walk(root, followlinks=False):
            entries += len(directories) + len(files)
            if entries > 100_000:
                raise ValueError('cache tree entry limit exceeded')
            for name in [*directories, *files]:
                path = Path(current) / name
                metadata = path.lstat()
                if path.is_symlink():
                    raise ValueError('cache tree contains a symbolic link')
                if path.is_file():
                    size += metadata.st_size
                    if size > 4 * 1024 * 1024 * 1024:
                        raise ValueError('cache tree byte limit exceeded')
except (OSError, ValueError):
    size = 0
print('true' if cache_hit else 'false', timings['indexMs'], duration, size, artifact['status'])
PY
)
  read -r cache_hit index_ms duration_ms cache_size status <<< "$metrics"
  if [[ "$cache_hit" != 'true' && "${REDLINE_CODE_INDEX_CACHE_READY:-false}" != 'true' ]]; then
    cache_size=0
  fi

  warmup_result=not-requested
  if [[ "${REDLINE_CODE_INDEX_MODE:-review}" == 'warmup' ]]; then
    if [[ "$cache_hit" == 'true' ]]; then
      warmup_result=hit
    elif [[ "${REDLINE_CODE_INDEX_CACHE_READY:-false}" == 'true' && "$save_outcome" == 'success' ]]; then
      warmup_result=saved
    elif [[ "${REDLINE_CODE_INDEX_CACHE_READY:-false}" == 'true' && "$save_outcome" == 'failure' ]]; then
      warmup_result=save-failed
    else
      warmup_result=failed
    fi
  fi

  write_output context-file "$context_file"
  write_output status "$status"
  write_output cache-hit "$cache_hit"
  write_output cache-identity "${REDLINE_CODE_INDEX_CACHE_IDENTITY:-}"
  write_output cache-save-outcome "$save_outcome"
  write_output cache-size-bytes "$cache_size"
  write_output duration-ms "$duration_ms"
  write_output index-ms "$index_ms"
  write_output warmup-result "$warmup_result"
}
