#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly RUNTIME_ROOT="${RUNNER_TEMP:?RUNNER_TEMP is required}/redline-code-index"
readonly CONTROL_DIR="$RUNTIME_ROOT/control"
readonly CACHE_ROOT="$RUNTIME_ROOT/cache"
readonly SOURCE_ROOT="$RUNTIME_ROOT/source"
readonly HEAD_SOURCE_ROOT="$RUNTIME_ROOT/head-source"
readonly CGC_HOME="$RUNTIME_ROOT/home"
readonly TOOL_ROOT="$RUNTIME_ROOT/tool"
readonly PINNED_CGC="$TOOL_ROOT/cgc"
readonly CGC_VERSION='0.5.7'
readonly CGC_URL="https://github.com/CodeGraphContext/CodeGraphContext/releases/download/v${CGC_VERSION}/cgc-linux-x86_64"
readonly CGC_SHA256='9b62140c77e88d153de24abfaebe1977f320511b170bf9aea6087106601d0e5f'
readonly CONFIG_ID='falkordb-base-only-v2-calls-64x80-49152b'

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

provider_version() {
  local executable=$1
  env -i \
    HOME="$CGC_HOME" \
    PATH='/usr/local/bin:/usr/bin:/bin' \
    LANG='C.UTF-8' \
    LC_ALL='C.UTF-8' \
    TMPDIR="${RUNNER_TEMP}" \
    CGC_IGNORE_PROJECT_ENV='1' \
    "$executable" version
}

initialize_artifact() {
  local status=$1 code=$2 message=$3 installation_ms=$4
  python3 "$SCRIPT_DIR/export.py" initialize \
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

prepare() {
  rm -rf -- "$CONTROL_DIR" "$SOURCE_ROOT" "$HEAD_SOURCE_ROOT" "$CGC_HOME" "$TOOL_ROOT" "$CACHE_ROOT"
  mkdir -p -- "$CONTROL_DIR" "$CGC_HOME" "$TOOL_ROOT" "$CACHE_ROOT"

  local started platform_os platform_arch executable version_output installation_ms
  started=$(now_ns)
  platform_os=${RUNNER_OS:-$(uname -s)}
  platform_arch=${RUNNER_ARCH:-$(uname -m)}

  # Validate the output boundary before any provider work. Unlike index failure,
  # an unsafe output path cannot degrade safely because no artifact can be written.
  initialize_artifact unavailable code-index-preparing 'Code indexing has not completed.' 0

  if [[ "$platform_os" != 'Linux' || ! "$platform_arch" =~ ^(X64|x86_64)$ ]]; then
    installation_ms=$(elapsed_ms "$started")
    initialize_artifact unsupported cgc-platform-unsupported \
      "CGC ${CGC_VERSION} is pinned only for Linux x64 in this action." "$installation_ms"
    write_control installation-ms "$installation_ms"
    write_output available false
    return 0
  fi

  if [[ -n "${REDLINE_CGC_EXECUTABLE:-}" ]]; then
    executable=$REDLINE_CGC_EXECUTABLE
    if [[ ! -f "$executable" || -L "$executable" || ! -x "$executable" ]]; then
      installation_ms=$(elapsed_ms "$started")
      initialize_artifact unavailable cgc-test-executable-invalid \
        'The controlled CGC executable is not a regular executable file.' "$installation_ms"
      write_control installation-ms "$installation_ms"
      write_output available false
      return 0
    fi
  else
    local download="$TOOL_ROOT/cgc.download"
    if ! curl --fail --location --silent --show-error \
      --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 \
      --output "$download" "$CGC_URL"; then
      installation_ms=$(elapsed_ms "$started")
      initialize_artifact unavailable cgc-download-failed \
        "Could not download pinned CGC ${CGC_VERSION}." "$installation_ms"
      write_control installation-ms "$installation_ms"
      write_output available false
      return 0
    fi
    if ! printf '%s  %s\n' "$CGC_SHA256" "$download" | sha256sum --check --status; then
      rm -f -- "$download"
      installation_ms=$(elapsed_ms "$started")
      initialize_artifact unavailable cgc-checksum-mismatch \
        "Pinned CGC ${CGC_VERSION} failed SHA-256 verification." "$installation_ms"
      write_control installation-ms "$installation_ms"
      write_output available false
      return 0
    fi
    mv -- "$download" "$PINNED_CGC"
    chmod 0755 "$PINNED_CGC"
    executable=$PINNED_CGC
  fi

  if ! version_output=$(provider_version "$executable" 2>&1) \
    || [[ "$version_output" != "CodeGraphContext ${CGC_VERSION}" ]]; then
    installation_ms=$(elapsed_ms "$started")
    initialize_artifact unavailable cgc-health-check-failed \
      "Pinned CGC health check did not report CodeGraphContext ${CGC_VERSION}." "$installation_ms"
    write_control installation-ms "$installation_ms"
    write_output available false
    return 0
  fi

  installation_ms=$(elapsed_ms "$started")
  local repository_digest config_digest platform_slug cache_prefix base run_suffix
  repository_digest=$(printf '%s' "$REDLINE_CODE_INDEX_REPOSITORY" | sha256sum | cut -d' ' -f1)
  config_digest=$(printf '%s' "$CONFIG_ID" | sha256sum | cut -d' ' -f1)
  platform_slug="linux-x64"
  base=$(printf '%s' "$REDLINE_CODE_INDEX_BASE" | tr '[:upper:]' '[:lower:]')
  cache_prefix="redline-code-index-v2-cgc-${CGC_VERSION}-${platform_slug}-${repository_digest}-${config_digest}"
  run_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

  write_control executable "$executable"
  write_control installation-ms "$installation_ms"
  write_control restore-start-ns "$(now_ns)"
  write_control cache-primary-key "${cache_prefix}-${base}-${run_suffix}"
  write_control cache-base-prefix "${cache_prefix}-${base}-"
  write_control config-id "$CONFIG_ID"

  initialize_artifact unavailable code-index-awaiting-provider \
    'Pinned CGC is ready; base-revision cache restore and indexing have not completed.' "$installation_ms"

  write_output available true
  write_output cache-path "$CACHE_ROOT"
  write_output cache-primary-key "${cache_prefix}-${base}-${run_suffix}"
  write_output cache-base-prefix "${cache_prefix}-${base}-"
}

build() {
  local executable installation_ms restore_started restore_ms build_result cache_ready
  executable=$(read_control executable)
  installation_ms=$(read_control installation-ms)
  restore_started=$(read_control restore-start-ns)
  restore_ms=$(elapsed_ms "$restore_started")

  python3 "$SCRIPT_DIR/export.py" build \
    --base "${REDLINE_CODE_INDEX_BASE}" \
    --head "${REDLINE_CODE_INDEX_HEAD}" \
    --repository "${REDLINE_CODE_INDEX_REPOSITORY}" \
    --output-directory "${REDLINE_CODE_INDEX_OUTPUT_DIRECTORY}" \
    --workspace "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}" \
    --source-root "$SOURCE_ROOT" \
    --head-source-root "$HEAD_SOURCE_ROOT" \
    --cache-root "$CACHE_ROOT" \
    --cgc-home "$CGC_HOME" \
    --executable "$executable" \
    --configuration-id "$(read_control config-id)" \
    --installation-ms "$installation_ms" \
    --restore-ms "$restore_ms" \
    --cache-matched-key "${REDLINE_CODE_INDEX_CACHE_MATCHED_KEY:-}" \
    --cache-restore-outcome "${REDLINE_CODE_INDEX_CACHE_RESTORE_OUTCOME:-skipped}" \
    --result-file "$CONTROL_DIR/build-result.json"

  build_result="$CONTROL_DIR/build-result.json"
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
    --save-outcome "$save_outcome"

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

case "${1:-}" in
  prepare) prepare ;;
  build) build ;;
  save-start) save_start ;;
  finalize) finalize ;;
  *) printf 'Usage: %s {prepare|build|save-start|finalize}\n' "$0" >&2; exit 2 ;;
esac
