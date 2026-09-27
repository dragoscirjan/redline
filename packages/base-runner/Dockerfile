# syntax=docker/dockerfile:1.7
# Small shared runtime base. Keep harness-specific tools in each runner image.
ARG NODE_BASE=node:24-alpine
FROM ${NODE_BASE}

COPY packages/base-runner/mcp/package.json /opt/redline/mcp/package.json
COPY packages/base-runner/mcp/package-lock.json /opt/redline/mcp/package-lock.json
COPY packages/base-runner/mcp/codegraphcontext-requirements.txt /opt/redline/mcp/codegraphcontext-requirements.txt
RUN apk add --no-cache python3 uv \
    && addgroup -S -g 10001 redline \
    && adduser -S -D -H -u 10001 -G redline redline \
    && mkdir -p /workspace /tmp/redline /opt/redline/mcp \
    && npm ci --prefix /opt/redline/mcp --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir -p /opt/redline/bin /opt/redline/uv-tools \
    && UV_TOOL_DIR=/opt/redline/uv-tools UV_TOOL_BIN_DIR=/opt/redline/bin UV_CACHE_DIR=/tmp/redline/uv-cache uv tool install --python python3 --requirements /opt/redline/mcp/codegraphcontext-requirements.txt \
    && mkdir -p /var/lib/redline/mcp/gitnexus /var/lib/redline/mcp/codegraphcontext/config /var/lib/redline/mcp/codegraphcontext/data /var/lib/redline/mcp/codegraphcontext/cache \
    && chown -R 10001:10001 /var/lib/redline/mcp \
    && chmod -R 0750 /var/lib/redline/mcp \
    && ln -s /opt/redline/mcp/node_modules/.bin/gitnexus /opt/redline/bin/gitnexus \
    && chown -R root:root /opt/redline/bin /opt/redline/uv-tools /opt/redline/mcp \
    && chmod -R a+rX /opt/redline/bin /opt/redline/uv-tools /opt/redline/mcp \
    && chown redline:redline /workspace /tmp/redline \
    && chmod 0700 /tmp/redline

ENV HOME=/tmp/redline \
    TMPDIR=/tmp/redline \
    NODE_ENV=production \
    PATH="/opt/redline/bin:${PATH}" \
    REDLINE_MCP_ROOT=/opt/redline/mcp/node_modules

WORKDIR /workspace
USER 10001:10001

ENTRYPOINT ["/bin/sh"]
