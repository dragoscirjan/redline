#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly PROVIDER=${REDLINE_CODE_INDEX_PROVIDER:-cgc}
readonly MODE=${REDLINE_CODE_INDEX_MODE:-review}

case "$MODE" in
  review|warmup) ;;
  *)
    printf 'Unsupported code-index mode: %s\n' "$MODE" >&2
    exit 2
    ;;
esac

case "$PROVIDER" in
  cgc|gitnexus)
    exec bash "$SCRIPT_DIR/run-${PROVIDER}.sh" "${1:-}"
    ;;
  *)
    printf 'Unsupported code-index provider: %s\n' "$PROVIDER" >&2
    exit 2
    ;;
esac
