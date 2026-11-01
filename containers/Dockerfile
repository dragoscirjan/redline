FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
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
RUN python3 -m venv /opt/cgc \
    && /opt/cgc/bin/pip install --no-cache-dir --require-hashes -r requirements.txt

ENV PATH="/opt/cgc/bin:/opt/harness/node_modules/.bin:${PATH}" \
    LANG=C.UTF-8 DO_NOT_TRACK=1 PI_SKIP_VERSION_CHECK=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_TELEMETRY=1
COPY --chmod=0555 containers/run-harness.sh /usr/local/bin/redline-harness
USER 10001:10001
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/redline-harness"]
