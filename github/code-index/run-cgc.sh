#!/usr/bin/env bash
set -euo pipefail

RUNNER_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly RUNNER_SCRIPT_DIR
# shellcheck disable=SC1091  # Resolved relative to this action at runtime.
source "$RUNNER_SCRIPT_DIR/common.sh"

readonly PROVIDER_ID='cgc'
readonly PROVIDER_VERSION='0.5.7'
readonly PINNED_CGC="$TOOL_ROOT/cgc"
readonly CGC_URL="https://github.com/CodeGraphContext/CodeGraphContext/releases/download/v${PROVIDER_VERSION}/cgc-linux-x86_64"
readonly CGC_SHA256='9b62140c77e88d153de24abfaebe1977f320511b170bf9aea6087106601d0e5f'
readonly CONFIG_ID='falkordb-base-only-v2-calls-64x80-49152b'

provider_version() {
  local executable=$1
  env -i \
    HOME="$PROVIDER_HOME" \
    PATH='/usr/local/bin:/usr/bin:/bin' \
    LANG='C.UTF-8' \
    LC_ALL='C.UTF-8' \
    TMPDIR="${RUNNER_TEMP}" \
    CGC_IGNORE_PROJECT_ENV='1' \
    "$executable" version
}

prepare() {
  rm -rf -- "$CONTROL_DIR" "$SOURCE_ROOT" "$HEAD_SOURCE_ROOT" "$PROVIDER_HOME" "$TOOL_ROOT" "$CACHE_ROOT"
  mkdir -p -- "$CONTROL_DIR" "$PROVIDER_HOME" "$TOOL_ROOT" "$CACHE_ROOT"

  local started platform_os platform_arch executable version_output installation_ms
  started=$(now_ns)
  platform_os=${RUNNER_OS:-$(uname -s)}
  platform_arch=${RUNNER_ARCH:-$(uname -m)}

  initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable code-index-preparing \
    'Code indexing has not completed.' 0

  if [[ "$platform_os" != 'Linux' || ! "$platform_arch" =~ ^(X64|x86_64)$ ]]; then
    installation_ms=$(elapsed_ms "$started")
    initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unsupported cgc-platform-unsupported \
      "CGC ${PROVIDER_VERSION} is pinned only for Linux x64 in this action." "$installation_ms"
    write_control installation-ms "$installation_ms"
    write_output available false
    return 0
  fi

  if [[ -n "${REDLINE_CGC_EXECUTABLE:-}" ]]; then
    executable=$REDLINE_CGC_EXECUTABLE
    if [[ ! -f "$executable" || -L "$executable" || ! -x "$executable" ]]; then
      installation_ms=$(elapsed_ms "$started")
      initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable cgc-test-executable-invalid \
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
      initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable cgc-download-failed \
        "Could not download pinned CGC ${PROVIDER_VERSION}." "$installation_ms"
      write_control installation-ms "$installation_ms"
      write_output available false
      return 0
    fi
    if ! printf '%s  %s\n' "$CGC_SHA256" "$download" | sha256sum --check --status; then
      rm -f -- "$download"
      installation_ms=$(elapsed_ms "$started")
      initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable cgc-checksum-mismatch \
        "Pinned CGC ${PROVIDER_VERSION} failed SHA-256 verification." "$installation_ms"
      write_control installation-ms "$installation_ms"
      write_output available false
      return 0
    fi
    mv -- "$download" "$PINNED_CGC"
    chmod 0755 "$PINNED_CGC"
    executable=$PINNED_CGC
  fi

  if ! version_output=$(provider_version "$executable" 2>&1) \
    || [[ "$version_output" != "CodeGraphContext ${PROVIDER_VERSION}" ]]; then
    installation_ms=$(elapsed_ms "$started")
    initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable cgc-health-check-failed \
      "Pinned CGC health check did not report CodeGraphContext ${PROVIDER_VERSION}." "$installation_ms"
    write_control installation-ms "$installation_ms"
    write_output available false
    return 0
  fi

  installation_ms=$(elapsed_ms "$started")
  local repository_digest config_digest cache_prefix base run_suffix
  repository_digest=$(printf '%s' "$REDLINE_CODE_INDEX_REPOSITORY" | sha256sum | cut -d' ' -f1)
  config_digest=$(printf '%s' "$CONFIG_ID" | sha256sum | cut -d' ' -f1)
  base=$(printf '%s' "$REDLINE_CODE_INDEX_BASE" | tr '[:upper:]' '[:lower:]')
  cache_prefix="redline-code-index-v2-${PROVIDER_ID}-${PROVIDER_VERSION}-linux-x64-${repository_digest}-${config_digest}"
  run_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

  write_control executable "$executable"
  write_control installation-ms "$installation_ms"
  write_control restore-start-ns "$(now_ns)"
  write_control config-id "$CONFIG_ID"

  initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable code-index-awaiting-provider \
    'Pinned CGC is ready; base-revision cache restore and indexing have not completed.' "$installation_ms"

  write_output available true
  write_output cache-path "$CACHE_ROOT"
  write_output cache-identity "${cache_prefix}-${base}"
  write_output cache-primary-key "${cache_prefix}-${base}-${run_suffix}"
  write_output cache-base-prefix "${cache_prefix}-${base}-"
}

build() {
  local executable installation_ms restore_started restore_ms
  executable=$(read_control executable)
  installation_ms=$(read_control installation-ms)
  restore_started=$(read_control restore-start-ns)
  restore_ms=$(elapsed_ms "$restore_started")

  python3 "$SCRIPT_DIR/export.py" build \
    --provider "$PROVIDER_ID" \
    --provider-version "$PROVIDER_VERSION" \
    --mode "${REDLINE_CODE_INDEX_MODE:-review}" \
    --base "${REDLINE_CODE_INDEX_BASE}" \
    --head "${REDLINE_CODE_INDEX_HEAD}" \
    --repository "${REDLINE_CODE_INDEX_REPOSITORY}" \
    --output-directory "${REDLINE_CODE_INDEX_OUTPUT_DIRECTORY}" \
    --workspace "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}" \
    --source-root "$SOURCE_ROOT" \
    --head-source-root "$HEAD_SOURCE_ROOT" \
    --cache-root "$CACHE_ROOT" \
    --provider-home "$PROVIDER_HOME" \
    --executable "$executable" \
    --runtime-executable "$executable" \
    --query-adapter "$SCRIPT_DIR/gitnexus-query.mjs" \
    --configuration-id "$(read_control config-id)" \
    --installation-ms "$installation_ms" \
    --restore-ms "$restore_ms" \
    --cache-matched-key "${REDLINE_CODE_INDEX_CACHE_MATCHED_KEY:-}" \
    --cache-restore-outcome "${REDLINE_CODE_INDEX_CACHE_RESTORE_OUTCOME:-skipped}" \
    --result-file "$CONTROL_DIR/build-result.json"

  write_build_output
}

case "${1:-}" in
  prepare) prepare ;;
  build) build ;;
  save-start) save_start ;;
  finalize) finalize ;;
  *) printf 'Usage: %s {prepare|build|save-start|finalize}\n' "$0" >&2; exit 2 ;;
esac
