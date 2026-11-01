FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime-base

FROM runtime-base AS dependencies
WORKDIR /opt/harness
COPY containers/pins.json containers/install-pnpm.mjs /build/
RUN node /build/install-pnpm.mjs
COPY containers/package.json containers/pnpm-lock.yaml containers/pnpm-workspace.yaml ./
COPY containers/pi/package.json pi/package.json
COPY containers/opencode/package.json opencode/package.json

FROM dependencies AS pi-dependencies
RUN node /opt/pnpm/bin/pnpm.cjs install --frozen-lockfile --prod --ignore-scripts --filter @redline-private/worker-pi...

FROM dependencies AS opencode-dependencies
RUN node /opt/pnpm/bin/pnpm.cjs install --frozen-lockfile --prod --ignore-scripts --filter @redline-private/worker-opencode...

FROM runtime-base AS worker
ARG REDLINE_REVISION
ARG SOURCE_DATE_EPOCH
ARG REDLINE_SOURCE_KIND=development
WORKDIR /opt/redline
COPY package.json LICENSE ./
COPY bin/runtime.mjs bin/redline-worker.mjs ./bin/
COPY src/process-runner.ts ./src/
COPY src/local/process.ts ./src/local/
COPY src/harness-executor/ ./src/harness-executor/
COPY src/harness-worker/ ./src/harness-worker/
COPY src/transport/ ./src/transport/
COPY containers/pins.json containers/metadata.mjs /build/
ENV HOME=/tmp/redline TMPDIR=/tmp/redline LANG=C.UTF-8 \
    DO_NOT_TRACK=1 PI_SKIP_VERSION_CHECK=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_TELEMETRY=1
LABEL org.opencontainers.image.source="https://github.com/dragoscirjan/redline" \
      org.opencontainers.image.revision="${REDLINE_REVISION}" \
      io.redline.source-kind="${REDLINE_SOURCE_KIND}"

FROM worker AS pi
ARG REDLINE_REVISION
ARG REDLINE_SOURCE_KIND
COPY --from=pi-dependencies /opt/harness/ /opt/harness/
RUN REDLINE_REVISION="$REDLINE_REVISION" REDLINE_SOURCE_KIND="$REDLINE_SOURCE_KIND" node /build/metadata.mjs pi
USER 10001:10001
ENTRYPOINT ["node", "/opt/redline/bin/redline-worker.mjs"]

FROM worker AS opencode
ARG REDLINE_REVISION
ARG REDLINE_SOURCE_KIND
COPY --from=opencode-dependencies /opt/harness/ /opt/harness/
RUN REDLINE_REVISION="$REDLINE_REVISION" REDLINE_SOURCE_KIND="$REDLINE_SOURCE_KIND" node /build/metadata.mjs opencode
USER 10001:10001
ENTRYPOINT ["node", "/opt/redline/bin/redline-worker.mjs"]
