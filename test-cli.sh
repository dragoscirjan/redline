#! /bin/bash

# export $(cat ~/.env | grep -v '#')

set -a
source "$HOME/.env"
set +a

RUN="run-$(date +%s)-$$"
REPO="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
REVIEW_HEAD="$(git rev-parse HEAD)"

HARNESS="${1:-pi}"
INDEXING="${TEST_INDEXING:-enabled}"
INDEXING_PROVIDER="${2:-cgc}"

echo "CWD: ${REPO}"
mkdir -p $REPO/.reviews

MISE_TRUSTED_CONFIG_PATHS="$(pwd)" mise exec -- node bin/redline.mjs review \
  --base origin/main --head ${REVIEW_HEAD} \
  --harness "${HARNESS}" \
  --provider openrouter \
  --indexing "${INDEXING}" \
  --indexing-provider "${INDEXING_PROVIDER}" \
  --max-output-tokens 32768 \
  --model-protocol openrouter-json \
  --scheduling mixed \
  --run-timeout 20m \
  \
  --endpoint https://openrouter.ai/api/v1 \
  --model z-ai/glm-5.3-flash
#  2>&1 | tee $REPO/.reviews/$RUN.log
