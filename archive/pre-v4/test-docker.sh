#!/usr/bin/env bash
set -eo pipefail
umask 077

if (( $# > 1 )) || [[ "${1:-}" != "" && "${1:-}" != --check-only && "${1:-}" != --startup-test ]]; then
  printf 'Usage: %s [--check-only|--startup-test]\n' "$0" >&2
  exit 2
fi

# Read only this literal assignment. Sourcing unquoted JSON removes its quotes.
# Do not execute ~/.env or forward its other credentials to the container.
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?REDLINE_MODEL_AUTH[[:space:]]*=(.*)$ ]]; then
    REDLINE_MODEL_AUTH="${BASH_REMATCH[2]}"
  fi
done < "$HOME/.env"
export REDLINE_MODEL_AUTH
set -u

if [[ -z "${REDLINE_MODEL_AUTH:-}" ]]; then
  printf '%s\n' 'REDLINE_MODEL_AUTH is missing. Set a provider-keyed JSON object in ~/.env.' >&2
  exit 2
fi

BUILD_ROOT="$(git rev-parse --show-toplevel)"
printf 'Build context: %s\n' "$BUILD_ROOT"
docker build --file "$BUILD_ROOT/containers/Dockerfile" --tag redline:dev "$BUILD_ROOT"
docker run --rm redline:dev --help

# Canonicalize literal JSON, single-quoted JSON, or a JSON-encoded string.
# The value stays in command substitution/environment, never a command argument.
REDLINE_MODEL_AUTH="$(docker run --rm --pull=never --network none \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --env REDLINE_MODEL_AUTH --entrypoint node redline:dev --input-type=module -e '
    import { selectModelCredential } from "/opt/redline/src/review/environment.ts";
    try {
      let raw = (process.env.REDLINE_MODEL_AUTH ?? "").trim();
      if (raw.startsWith(String.fromCharCode(39)) && raw.endsWith(String.fromCharCode(39))) raw = raw.slice(1, -1);
      let auth = JSON.parse(raw);
      if (typeof auth === "string") auth = JSON.parse(auth);
      const canonical = JSON.stringify(auth);
      selectModelCredential({ provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", auth: undefined }, canonical);
      process.stdout.write(canonical);
    } catch {
      console.error("Preflight failed: REDLINE_MODEL_AUTH must be a JSON object with a nonempty openrouter credential.");
      process.exitCode = 2;
    }
  ')"
export REDLINE_MODEL_AUTH

CACHE="$HOME/.cache/redline-docker"
OUTPUT="$HOME/.local/state/redline-docker"
RUN="run-$(date +%s)-$$"
REPO="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
REVIEW_HEAD="$(git rev-parse HEAD)"

mkdir -p "$CACHE" "$OUTPUT"
printf 'Repository mount: %s\nReview head: %s\nReports: %s/%s\n' "$REPO" "$REVIEW_HEAD" "$OUTPUT" "$RUN"

container_args=(
  --rm --pull=never --init
  --user "$(id -u):$(id -g)"
  --read-only --cap-drop ALL --security-opt no-new-privileges
  --memory 2g --cpus 2 --pids-limit 256
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777"
  --mount "type=bind,src=$REPO,dst=/repository,readonly"
  --mount "type=bind,src=$CACHE,dst=/cache"
  --mount "type=bind,src=$OUTPUT,dst=/output"
  --env REDLINE_MODEL_AUTH
)
RUN_TIMEOUT=20m
if [[ "${1:-}" == --startup-test ]]; then
  RUN_TIMEOUT=2m
fi
review_args=(
  --repository /repository
  --base origin/main --head "$REVIEW_HEAD"
  --harness pi
  --provider openrouter
  --endpoint https://openrouter.ai/api/v1
  --model z-ai/glm-5.3-flash
  --max-output-tokens 32768
  --model-protocol openrouter-json
  --scheduling mixed
  --run-timeout "$RUN_TIMEOUT"
  --output "/output/$RUN"
)
if [[ "${1:-}" == --startup-test ]]; then
  # Bounded real startup, not a complete review. Keep reasoning enabled.
  review_args+=(--concurrency 1 --timeout 1m --retries 0)
fi

# Parse exactly the same settings offline; never start a review or print keys here.
docker run "${container_args[@]}" --network none --entrypoint node redline:dev \
  --input-type=module -e '
    import { parseLocalOptions } from "/opt/redline/src/local/options.ts";
    try {
      await parseLocalOptions(process.argv.slice(1), process.env, process.cwd());
      console.log("Preflight passed: repository, arguments and credential JSON.");
    } catch (error) {
      const raw = process.env.REDLINE_MODEL_AUTH ?? "";
      const secrets = [raw];
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string") secrets.push(parsed);
        else if (parsed !== null && typeof parsed === "object") {
          secrets.push(...Object.values(parsed).filter(value => typeof value === "string"));
        }
      } catch { /* Malformed JSON is classified by the trusted parser. */ }
      let message = error instanceof Error ? error.message : "configuration check failed";
      for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, "[REDACTED]");
      console.error("Preflight failed: " + message);
      if (/model-auth|credential|REDLINE_MODEL_AUTH|JSON/i.test(message)) {
        console.error("Expected REDLINE_MODEL_AUTH to contain a provider-keyed JSON object.");
        console.error("When sourcing ~/.env, wrap the whole JSON value in single quotes.");
      }
      process.exitCode = 2;
    }
  ' -- "${review_args[@]}"

if [[ "${1:-}" == --check-only ]]; then
  exit 0
fi

docker run "${container_args[@]}" redline:dev review "${review_args[@]}"
