#!/usr/bin/env bash
# Run from the checkout/branch to review. Use "both" to exercise both native harnesses.
set -euo pipefail
umask 077

MODE=cli
if [[ "${1:-}" == --docker ]]; then MODE=docker; shift; fi
HARNESS="${1:-pi}"
case "$HARNESS" in
  pi|opencode) HARNESSES=("$HARNESS") ;;
  both) HARNESSES=(pi opencode) ;;
  *) printf 'Usage: %s [--docker] [pi|opencode|both]\n' "$0" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(git rev-parse --show-toplevel)"
REVIEW_HEAD="$(git rev-parse HEAD)"
RUN="run-$(date +%Y%m%dT%H%M%S)-$$"
NODE="${TEST_NODE:-node}"
LOG_DIR="${TEST_LOG_DIR:-$REPO/.reviews}"
OUTPUT_PARENT="${TEST_OUTPUT_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/redline-test}"
mkdir -p "$LOG_DIR" "$OUTPUT_PARENT"

# Preserve literal JSON instead of sourcing ~/.env and stripping its inner quotes.
# Only the selected model-auth assignment is read; other secrets and shell commands are not loaded.
if [[ -z "${REDLINE_MODEL_AUTH:-}" && -r "$HOME/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?REDLINE_MODEL_AUTH[[:space:]]*=(.*)$ ]]; then
      REDLINE_MODEL_AUTH="${BASH_REMATCH[2]}"
    fi
  done < "$HOME/.env"
fi
if [[ -z "${REDLINE_MODEL_AUTH:-}" ]]; then
  printf '%s\n' 'REDLINE_MODEL_AUTH is missing. Supply a provider-keyed JSON object through the environment or ~/.env.' >&2
  exit 2
fi
export REDLINE_MODEL_AUTH
REDLINE_MODEL_AUTH="$("$NODE" --input-type=module -e '
  try {
    let raw = (process.env.REDLINE_MODEL_AUTH ?? "").trim();
    if (raw.startsWith(String.fromCharCode(39)) && raw.endsWith(String.fromCharCode(39))) raw = raw.slice(1, -1);
    let auth = JSON.parse(raw);
    if (typeof auth === "string") auth = JSON.parse(auth);
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw Error();
    process.stdout.write(JSON.stringify(auth));
  } catch {
    console.error("REDLINE_MODEL_AUTH must be a provider-keyed JSON object; no credential values were printed.");
    process.exitCode = 2;
  }
')"
export REDLINE_MODEL_AUTH

PROVIDER="${REDLINE_PROVIDER:-openrouter}"
ENDPOINT="${REDLINE_ENDPOINT:-https://openrouter.ai/api/v1}"
MODEL="${REDLINE_MODEL:-z-ai/glm-5.3-flash}"
# This helper supplies all model fields explicitly; an inherited JSON default must not mask them.
unset REDLINE_MODEL_CONFIG
# Decide before tee turns the child streams into pipes. Explicit always also works through redirected output.
PROGRESS="${REDLINE_PROGRESS:-auto}"
if [[ "$PROGRESS" == auto && -t 2 && "${TERM:-}" != dumb ]]; then PROGRESS=always; fi
if [[ "$MODE" == docker ]]; then
  IMAGE="${TEST_DOCKER_IMAGE:-redline:dev}"
  CACHE="${TEST_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/redline-docker}"
  mkdir -p "$CACHE"
  if [[ "${TEST_SKIP_BUILD:-0}" != 1 ]]; then
    docker build --file "$SCRIPT_DIR/containers/Dockerfile" --tag "$IMAGE" "$SCRIPT_DIR"
  fi
  container_args=(--rm --pull=never --init --user "$(id -u):$(id -g)"
    --read-only --cap-drop ALL --security-opt no-new-privileges
    --memory 2g --cpus 2 --pids-limit 256
    --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777"
    --workdir "$REPO" --mount "type=bind,src=$REPO,dst=$REPO,readonly"
    --mount "type=bind,src=$CACHE,dst=/cache"
    --mount "type=bind,src=$OUTPUT_PARENT,dst=/output"
    --env REDLINE_MODEL_AUTH)
  COMMON_GIT="$(git rev-parse --path-format=absolute --git-common-dir)"
  if [[ "$COMMON_GIT" != "$REPO/"* ]]; then
    container_args+=(--mount "type=bind,src=$COMMON_GIT,dst=$COMMON_GIT,readonly")
  fi
  if [[ -n "${TEST_DOCKER_NETWORK:-}" ]]; then container_args+=(--network "$TEST_DOCKER_NETWORK"); fi
  # Host configuration is mounted only when explicitly requested.
  if [[ -n "${TEST_DOCKER_HOME:-}" ]]; then
    NATIVE_HOME="$(cd -- "$TEST_DOCKER_HOME" && pwd -P)"
    container_args+=(--mount "type=bind,src=$NATIVE_HOME,dst=$NATIVE_HOME"
      --env "HOME=$NATIVE_HOME" --env "XDG_CONFIG_HOME=$NATIVE_HOME/.config"
      --env "XDG_CACHE_HOME=$NATIVE_HOME/.cache" --env "XDG_DATA_HOME=$NATIVE_HOME/.local/share"
      --env "XDG_STATE_HOME=$NATIVE_HOME/.local/state")
  fi
fi

status=0
for harness in "${HARNESSES[@]}"; do
  protocol=compatible
  if [[ "$harness" == pi && "$PROVIDER" == openrouter ]]; then protocol=openrouter-json; fi
  protocol="${REDLINE_MODEL_PROTOCOL:-$protocol}"
  log="$LOG_DIR/$RUN-$harness.log"
  output="$OUTPUT_PARENT/$RUN-$harness"
  target_output="$output"
  if [[ "$MODE" == docker ]]; then target_output="/output/$RUN-$harness"; fi
  review_args=(review --progress "$PROGRESS" --repository "$REPO" --base "${REDLINE_BASE:-origin/main}" --head "$REVIEW_HEAD"
    --harness "$harness" --provider "$PROVIDER" --endpoint "$ENDPOINT" --model "$MODEL"
    --max-output-tokens "${REDLINE_MAX_OUTPUT_TOKENS:-32768}" --model-protocol "$protocol"
    --scheduling mixed --indexing "${REDLINE_INDEXING:-enabled}" --indexing-provider "${REDLINE_INDEXING_PROVIDER:-cgc}"
    --concurrency "${REDLINE_REVIEW_CONCURRENCY:-4}" --retries "${REDLINE_RETRIES:-3}"
    --timeout "${REDLINE_TIMEOUT:-4m}" --run-timeout "${REDLINE_RUN_TIMEOUT:-20m}"
    --output "$target_output")
  run_review() {
    printf 'Repository: %s\nHead: %s\nHarness: %s\nLog: %s\nArtifacts: %s\n' "$REPO" "$REVIEW_HEAD" "$harness" "$log" "$output"
    printf 'Native indexing: %s, provider %s. Checks and indexing run in model warmup.\n' "${REDLINE_INDEXING:-enabled}" "${REDLINE_INDEXING_PROVIDER:-cgc}"
    if [[ "$MODE" == docker ]]; then
      # A fixture can retain the daemon-owned container ID for timeout teardown.
      docker_args=("${container_args[@]}")
      if [[ -n "${TEST_DOCKER_CIDFILE:-}" ]]; then docker_args+=(--cidfile "$TEST_DOCKER_CIDFILE-$harness"); fi
      docker run "${docker_args[@]}" "$IMAGE" "${review_args[@]}"
    else
      "$NODE" "$SCRIPT_DIR/bin/redline.mjs" "${review_args[@]}"
    fi
  }
  if run_review 2>&1 | tee "$log"; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  if (( pipeline_status[0] != 0 && status == 0 )); then status="${pipeline_status[0]}"; fi
  if (( pipeline_status[1] != 0 && status == 0 )); then status="${pipeline_status[1]}"; fi
done
exit "$status"
