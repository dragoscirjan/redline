# syntax=docker/dockerfile:1.7
ARG RUNNER_BASE=redline-runner-base:local
FROM ${RUNNER_BASE}

ARG PI_VERSION=0.87.1
USER root
COPY packages/pi-runner/pi/settings.json /etc/redline/pi/settings.json
RUN apt-get update \
    && apt-get install --no-install-recommends --yes bash ca-certificates git \
    && npm install --global --omit=dev "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force \
    && chown -R root:root /usr/local/lib/node_modules /usr/local/bin \
    && chmod -R go-w /usr/local/lib/node_modules /usr/local/bin \
    && rm -rf /var/lib/apt/lists/*

ENV PI_SETTINGS_PATH=/etc/redline/pi/settings.json \
    PI_CODING_AGENT_DIR=/tmp/redline/pi
USER 10001:10001

ENTRYPOINT ["node", "/opt/redline/bootstrap.js", "pi"]
