# Pi runner image

Build and push the shared base first, then build and push the harness image from the repository root with BuildKit/buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/base-runner/Dockerfile \
  --build-arg NODE_BASE=node:24-alpine \
  -t ghcr.io/OWNER/redline-base-runner:TAG \
  --push .

docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/pi-runner/Dockerfile \
  --build-arg RUNNER_BASE=ghcr.io/OWNER/redline-base-runner:TAG \
  --build-arg PI_VERSION=0.87.1 \
  -t ghcr.io/OWNER/redline-pi-runner:TAG \
  --push .
```

Replace `OWNER` and `TAG` with the GHCR owner and matching base-image tag. Set `NODE_BASE` to an approved base image digest when producing a release. `PI_VERSION` pins the CLI package version. Verify Pi's runtime and native dependency support for both architectures in Linux CI before publishing.

The image runs as UID/GID 10001. It contains no checkout or credentials. The MCP servers are installed in the shared base and configured in `pi/settings.json`; the Dockerfile copies that file to `/etc/redline/pi/settings.json`. GitNexus and CodeGraphContext use `/var/lib/redline/mcp` for persistent data. Mount the host-managed cache there, following the base runner's per-repository and per-architecture cache guidance. The mount must be writable by UID/GID 10001. The caller must provide a restricted execution environment and generate any other native Pi configuration in a private temporary directory at runtime. Disable Pi tools and project resource discovery when Redline's review policy requires it.

Run reviews with Pi JSON event output. Trusted host code extracts assistant `text_delta` events and parses `redline-review-events/v1` lines. This reporting path does not add a Pi tool or expose forge credentials to the container.

No image build has been run locally. Multi-platform build validation remains for Linux CI.
