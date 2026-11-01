FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun-runtime

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime-base
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx

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
COPY --chmod=0555 containers/run-harness.sh /usr/local/bin/redline-harness
COPY containers/pins.json containers/metadata.mjs /build/
ENV LANG=C.UTF-8 DO_NOT_TRACK=1 PI_SKIP_VERSION_CHECK=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_TELEMETRY=1
LABEL org.opencontainers.image.source="https://github.com/dragoscirjan/redline" \
      org.opencontainers.image.revision="${REDLINE_REVISION}" \
      io.redline.source-kind="${REDLINE_SOURCE_KIND}"

FROM worker AS pi
ARG REDLINE_REVISION
ARG REDLINE_SOURCE_KIND
ENV REDLINE_CONTAINER_HARNESS=pi
COPY --from=pi-dependencies /opt/harness/ /opt/harness/
RUN REDLINE_REVISION="$REDLINE_REVISION" REDLINE_SOURCE_KIND="$REDLINE_SOURCE_KIND" node /build/metadata.mjs pi
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/redline-harness"]

FROM worker AS opencode
ARG REDLINE_REVISION
ARG REDLINE_SOURCE_KIND
ENV REDLINE_CONTAINER_HARNESS=opencode
COPY --from=opencode-dependencies /opt/harness/ /opt/harness/
RUN REDLINE_REVISION="$REDLINE_REVISION" REDLINE_SOURCE_KIND="$REDLINE_SOURCE_KIND" node /build/metadata.mjs opencode
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/redline-harness"]
