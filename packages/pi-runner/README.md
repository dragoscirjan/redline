# Pi runner image

Build the shared base first, then build the harness image from the repository root with BuildKit/buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/base-runner/Dockerfile \
  --build-arg NODE_BASE=node:24-alpine \
  -t redline-runner-base:local \
  --load .

docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/pi-runner/Dockerfile \
  --build-arg RUNNER_BASE=redline-runner-base:local \
  --build-arg PI_VERSION=0.87.1 \
  .
```

For multi-platform builds, build and push the base image to a registry first. `--load` generally loads only one platform into a local Docker image store. Set `NODE_BASE` to an approved base image digest when producing a release. `PI_VERSION` pins the CLI package version. Verify Pi's runtime and native dependency support for both architectures in Linux CI before publishing.

The image runs as UID/GID 10001. It contains no checkout or credentials. The MCP servers are installed in the shared base and configured in `pi/settings.json`; the Dockerfile copies that file to `/etc/redline/pi/settings.json`. GitNexus and CodeGraphContext use `/var/lib/redline/mcp` for persistent data. Mount the host-managed cache there, following the base runner's per-repository and per-architecture cache guidance. The mount must be writable by UID/GID 10001. The caller must provide a restricted execution environment and generate any other native Pi configuration in a private temporary directory at runtime. Disable Pi tools and project resource discovery when Redline's review policy requires it.

No image build has been run locally. Multi-platform build validation remains for Linux CI.
