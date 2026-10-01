# OpenCode runner image

Build and push the shared base first, then build and push the harness image from the repository root with BuildKit/buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/base-runner/Dockerfile \
  --build-arg NODE_BASE=node:24-bookworm-slim \
  -t ghcr.io/OWNER/redline-base-runner:TAG \
  --push .

docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/opencode-runner/Dockerfile \
  --build-arg RUNNER_BASE=ghcr.io/OWNER/redline-base-runner:TAG \
  --build-arg OPENCODE_VERSION=1.18.32 \
  -t ghcr.io/OWNER/redline-opencode-runner:TAG \
  --push .
```

Replace `OWNER` and `TAG` with the GHCR owner and matching base-image tag. Set `NODE_BASE` to an approved base image digest when producing a release. `OPENCODE_VERSION` pins the CLI package version. Verify OpenCode's runtime and native dependency support for both architectures in Linux CI before publishing.

The image runs as UID/GID 10001. It contains no checkout or credentials. MCP packages and the development configuration remain in the image, but the review bootstrap does not load that configuration. The bootstrap creates a one-provider configuration under `/tmp/redline/run`. It denies every tool and disables project configuration, external skills, default plugins, and LSP downloads. The fixed Redline report plugin is the only configured plugin.

The image entrypoint is `/opt/redline/bootstrap.js`. It accepts one bounded host-generated envelope through stdin and rejects arbitrary native configuration. The selected model credential remains out of process arguments and generated files. `GH_TOKEN` and the complete credential map never enter the container.

The fixed `redline-report-plugin.js` output adapter forwards OpenCode `message.part.delta` text only when trusted host code sets `REDLINE_REPORT_EVENTS=1`. It binds the first coordinator session to the host-visible ID `redline-coordinator` and ignores later session IDs. It does not add a model tool, publish to a forge, or receive forge credentials. Host code parses the forwarded text through `redline-review-events/v1`.

A local `linux/amd64` image build and controlled fake-endpoint smoke run pass. Multi-platform build validation remains for Linux CI.
