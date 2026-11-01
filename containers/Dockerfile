FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun
FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337 AS python

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=python /usr/local/ /usr/local/
RUN ln -s bun /usr/local/bin/bunx \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/harness
COPY containers/package.json containers/pnpm-lock.yaml ./
# Prepare vendor binaries now so runtime node_modules can remain read-only.
RUN npm install --global --ignore-scripts pnpm@10.33.0 \
    && pnpm install --frozen-lockfile --prod --ignore-scripts \
    && node node_modules/opencode-ai/postinstall.mjs \
    && HOME=/tmp/gitnexus-build GITNEXUS_HOME=/tmp/gitnexus-build node_modules/.bin/gitnexus mcp </dev/null \
    && rm -rf /tmp/gitnexus-build

COPY containers/requirements.txt ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && python3 -m venv /opt/cgc \
    && /opt/cgc/bin/pip install --no-cache-dir --require-hashes -r requirements.txt \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/cgc/bin:/opt/harness/node_modules/.bin:${PATH}" \
    LANG=C.UTF-8 DO_NOT_TRACK=1 PI_SKIP_VERSION_CHECK=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_TELEMETRY=1
RUN ln -sf ../gitnexus/dist/cli/index.js /opt/harness/node_modules/.bin/gitnexus

WORKDIR /opt/redline
COPY package.json LICENSE ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY prompts/ ./prompts/
COPY schemas/ ./schemas/
RUN mkdir -p /cache /output && chown 10001:10001 /cache /output
ENV HOME=/tmp/redline/home XDG_STATE_HOME=/tmp/redline/state XDG_CACHE_HOME=/cache
VOLUME ["/cache", "/output"]
USER 10001:10001
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/redline/bin/redline.mjs"]
