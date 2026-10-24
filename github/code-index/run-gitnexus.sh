#!/usr/bin/env bash
set -euo pipefail

RUNNER_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly RUNNER_SCRIPT_DIR
# shellcheck disable=SC1091  # Resolved relative to this action at runtime.
source "$RUNNER_SCRIPT_DIR/common.sh"

readonly PROVIDER_ID='gitnexus'
readonly PROVIDER_VERSION='1.6.12'
readonly CONFIG_ID='ladybug-base-only-v1-coderelation-64x80-49152b'
readonly GITNEXUS_HOME="$CACHE_ROOT/gitnexus-home"
readonly INSTALLER="$REPOSITORY_ROOT/src/code-index/install-gitnexus.ts"
readonly QUERY_ADAPTER="$SCRIPT_DIR/gitnexus-query.mjs"

provider_version() {
  local runtime=$1 executable=$2
  env -i \
    HOME="$PROVIDER_HOME" \
    PATH='/usr/local/bin:/usr/bin:/bin' \
    LANG='C.UTF-8' \
    LC_ALL='C.UTF-8' \
    TMPDIR="${RUNNER_TEMP}" \
    GITNEXUS_HOME="$PROVIDER_HOME" \
    "$runtime" "$executable" --version
}

prepare() {
  rm -rf -- "$CONTROL_DIR" "$SOURCE_ROOT" "$HEAD_SOURCE_ROOT" "$PROVIDER_HOME" "$TOOL_ROOT" "$CACHE_ROOT"
  mkdir -p -- "$CONTROL_DIR" "$PROVIDER_HOME" "$TOOL_ROOT" "$CACHE_ROOT"

  local started platform_os platform_arch platform_slug executable runtime version_output installation_ms
  started=$(now_ns)
  platform_os=${RUNNER_OS:-$(uname -s)}
  platform_arch=${RUNNER_ARCH:-$(uname -m)}

  initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable code-index-preparing \
    'Code indexing has not completed.' 0

  if [[ "$platform_os" != 'Linux' ]]; then
    installation_ms=$(elapsed_ms "$started")
    initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unsupported gitnexus-platform-unsupported \
      "GitNexus ${PROVIDER_VERSION} is pinned only for Linux in this action." "$installation_ms"
    write_control installation-ms "$installation_ms"
    write_output available false
    return 0
  fi
  case "$platform_arch" in
    X64|x86_64) platform_slug='linux-x64' ;;
    ARM64|aarch64) platform_slug='linux-arm64' ;;
    *)
      installation_ms=$(elapsed_ms "$started")
      initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unsupported gitnexus-platform-unsupported \
        "GitNexus ${PROVIDER_VERSION} has no pinned native package for ${platform_arch}." "$installation_ms"
      write_control installation-ms "$installation_ms"
      write_output available false
      return 0
      ;;
  esac

  runtime=${REDLINE_GITNEXUS_RUNTIME:-$(command -v node || true)}
  if [[ -z "$runtime" || "$runtime" != /* || ! -f "$runtime" || -L "$runtime" || ! -x "$runtime" ]]; then
    installation_ms=$(elapsed_ms "$started")
    initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable gitnexus-runtime-invalid \
      'GitNexus requires a regular absolute Node.js executable.' "$installation_ms"
    write_control installation-ms "$installation_ms"
    write_output available false
    return 0
  fi

  if [[ -n "${REDLINE_GITNEXUS_EXECUTABLE:-}" ]]; then
    executable=$REDLINE_GITNEXUS_EXECUTABLE
  else
    local npm_executable tar_executable
    npm_executable=$(command -v npm || true)
    tar_executable=$(command -v tar || true)
    if [[ ! -f "$INSTALLER" || -L "$INSTALLER" || -z "$npm_executable" || -z "$tar_executable" ]]; then
      installation_ms=$(elapsed_ms "$started")
      initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable gitnexus-installer-unavailable \
        'The trusted pinned GitNexus installer is unavailable.' "$installation_ms"
      write_control installation-ms "$installation_ms"
      write_output available false
      return 0
    fi
    if ! executable=$("$runtime" "$INSTALLER" \
      "$TOOL_ROOT/gitnexus" "$TOOL_ROOT/work" "$runtime" "$npm_executable" "$tar_executable"); then
      installation_ms=$(elapsed_ms "$started")
      initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable gitnexus-install-failed \
        "Could not install pinned GitNexus ${PROVIDER_VERSION}." "$installation_ms"
      write_control installation-ms "$installation_ms"
      write_output available false
      return 0
    fi
  fi

  if [[ "$executable" != /* || ! -f "$executable" || -L "$executable" ]]; then
    installation_ms=$(elapsed_ms "$started")
    initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable gitnexus-executable-invalid \
      'The GitNexus CLI is not a regular absolute file.' "$installation_ms"
    write_control installation-ms "$installation_ms"
    write_output available false
    return 0
  fi
  if ! version_output=$(provider_version "$runtime" "$executable" 2>/dev/null) \
    || [[ "$version_output" != "$PROVIDER_VERSION" ]]; then
    installation_ms=$(elapsed_ms "$started")
    initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable gitnexus-health-check-failed \
      "Pinned GitNexus health check did not report ${PROVIDER_VERSION}." "$installation_ms"
    write_control installation-ms "$installation_ms"
    write_output available false
    return 0
  fi

  installation_ms=$(elapsed_ms "$started")
  local repository_digest config_digest cache_prefix base run_suffix
  repository_digest=$(printf '%s' "$REDLINE_CODE_INDEX_REPOSITORY" | sha256sum | cut -d' ' -f1)
  config_digest=$(printf '%s' "$CONFIG_ID" | sha256sum | cut -d' ' -f1)
  base=$(printf '%s' "$REDLINE_CODE_INDEX_BASE" | tr '[:upper:]' '[:lower:]')
  cache_prefix="redline-code-index-v2-${PROVIDER_ID}-${PROVIDER_VERSION}-${platform_slug}-${repository_digest}-${config_digest}"
  run_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

  write_control executable "$executable"
  write_control runtime-executable "$runtime"
  write_control installation-ms "$installation_ms"
  write_control restore-start-ns "$(now_ns)"
  write_control config-id "$CONFIG_ID"

  initialize_artifact "$PROVIDER_ID" "$PROVIDER_VERSION" unavailable code-index-awaiting-provider \
    'Pinned GitNexus is ready; base-revision cache restore and indexing have not completed.' "$installation_ms"

  write_output available true
  write_output cache-path "$CACHE_ROOT"
  write_output cache-identity "${cache_prefix}-${base}"
  write_output cache-primary-key "${cache_prefix}-${base}-${run_suffix}"
  write_output cache-base-prefix "${cache_prefix}-${base}-"
}

build() {
  local executable runtime installation_ms restore_started restore_ms
  executable=$(read_control executable)
  runtime=$(read_control runtime-executable)
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
    --provider-home "$GITNEXUS_HOME" \
    --executable "$executable" \
    --runtime-executable "$runtime" \
    --query-adapter "$QUERY_ADAPTER" \
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
