# syntax=docker/dockerfile:1.7
ARG RUNNER_BASE=redline-runner-base:local
FROM ${RUNNER_BASE}

ARG OPENCODE_VERSION=1.18.32
USER root
COPY packages/opencode-runner/opencode/opencode.json /etc/redline/opencode.json
RUN apk add --no-cache ca-certificates git \
    && npm install --global --omit=dev "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && chown -R 10001:10001 /usr/local/lib/node_modules /usr/local/bin

ENV OPENCODE_CONFIG_DIR=/tmp/redline/opencode \
    OPENCODE_CONFIG=/etc/redline/opencode.json

USER 10001:10001
USER 10001:10001

ENTRYPOINT ["opencode"]
