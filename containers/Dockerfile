# Reuse the pre-v4 pinned Node base and compiled-distribution build pattern.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /build
RUN npm install --global --ignore-scripts pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY scripts/build.js ./scripts/build.js
COPY src/ ./src/
RUN pnpm run build && pnpm prune --prod --ignore-scripts

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /opt/redline
COPY package.json LICENSE ./
COPY --from=build /build/node_modules/ ./node_modules/
COPY --from=build /build/dist/ ./dist/
COPY bin/ ./bin/
ENV NODE_ENV=production REDLINE_ENV=node
USER node
ENTRYPOINT ["node", "bin/redline.mjs"]
CMD ["status"]
