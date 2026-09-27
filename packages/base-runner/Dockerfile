# syntax=docker/dockerfile:1.7
# Small shared runtime base. Keep harness-specific tools in each runner image.
ARG NODE_BASE=node:24-bookworm-slim
FROM ${NODE_BASE}

# CodeGraphContext's falkordblite dependency builds native extensions and Redis.
ARG TARGETARCH
COPY packages/base-runner/mcp/package.json /opt/redline/mcp/package.json
COPY packages/base-runner/mcp/package-lock.json /opt/redline/mcp/package-lock.json
COPY packages/base-runner/mcp/codegraphcontext-requirements.txt /opt/redline/mcp/codegraphcontext-requirements.txt
RUN apt-get update \
    && apt-get install --no-install-recommends --yes python3 python3-venv build-essential curl ca-certificates \
    && case "${TARGETARCH}" in amd64) uv_arch=x86_64; uv_sha=5a360b0de092ddf4131f5313d0411b48c4e95e8107e40c3f8f2e9fcb636b3583 ;; arm64) uv_arch=aarch64; uv_sha=23003df007937dd607409c8ddf010baa82bad2673e60e254632ca5b04edcce13 ;; *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; esac \
    && curl --fail --silent --show-error --location "https://github.com/astral-sh/uv/releases/download/0.10.11/uv-${uv_arch}-unknown-linux-gnu.tar.gz" --output /tmp/uv.tar.gz \
    && printf '%s  %s\n' "${uv_sha}" /tmp/uv.tar.gz > /tmp/uv.tar.gz.sha256 \
    && sha256sum --check --status /tmp/uv.tar.gz.sha256 \
    && tar -xzf /tmp/uv.tar.gz --directory /tmp \
    && install -m 0755 "/tmp/uv-${uv_arch}-unknown-linux-gnu/uv" /usr/local/bin/uv \
    && rm -rf /tmp/uv.tar.gz /tmp/uv.tar.gz.sha256 "/tmp/uv-${uv_arch}-unknown-linux-gnu" \
    && groupadd --gid 10001 redline \
    && useradd --uid 10001 --gid redline --no-create-home --shell /usr/sbin/nologin redline \
    && mkdir -p /workspace /tmp/redline /opt/redline/mcp \
    && npm ci --prefix /opt/redline/mcp --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir -p /opt/redline/bin /opt/redline/uv-tools \
    && UV_TOOL_DIR=/opt/redline/uv-tools UV_TOOL_BIN_DIR=/opt/redline/bin UV_CACHE_DIR=/tmp/redline/uv-cache uv tool install --python python3 --with-requirements /opt/redline/mcp/codegraphcontext-requirements.txt codegraphcontext \
    && mkdir -p /var/lib/redline/mcp/gitnexus /var/lib/redline/mcp/codegraphcontext/config /var/lib/redline/mcp/codegraphcontext/data /var/lib/redline/mcp/codegraphcontext/cache \
    && chown -R 10001:10001 /var/lib/redline/mcp \
    && chmod -R 0750 /var/lib/redline/mcp \
    && ln -s /opt/redline/mcp/node_modules/.bin/gitnexus /opt/redline/bin/gitnexus \
    && chown -R root:root /opt/redline/bin /opt/redline/uv-tools /opt/redline/mcp \
    && chmod -R a+rX /opt/redline/bin /opt/redline/uv-tools /opt/redline/mcp \
    && chown redline:redline /workspace /tmp/redline \
    && chmod 0700 /tmp/redline \
    && apt-get purge --auto-remove --yes build-essential curl \
    && rm -rf /var/lib/apt/lists/* /tmp/redline/uv-cache

ENV HOME=/tmp/redline \
    TMPDIR=/tmp/redline \
    NODE_ENV=production \
    PATH="/opt/redline/bin:${PATH}" \
    REDLINE_MCP_ROOT=/opt/redline/mcp/node_modules

WORKDIR /workspace
USER 10001:10001

ENTRYPOINT ["/bin/sh"]
