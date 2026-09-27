# OpenCode runner image

Build and push the shared base first, then build and push the harness image from the repository root with BuildKit/buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/base-runner/Dockerfile \
  --build-arg NODE_BASE=node:24-alpine \
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

The image runs as UID/GID 10001. It contains no checkout or credentials. The MCP servers are installed in the shared base and configured in `opencode/opencode.json`; the Dockerfile copies that file to `/etc/redline/opencode.json`. GitNexus and CodeGraphContext use `/var/lib/redline/mcp` for persistent data. Mount the host-managed cache there, following the base runner's per-repository and per-architecture cache guidance. The mount must be writable by UID/GID 10001. The caller must provide a restricted execution environment and generate any other native OpenCode configuration in a private temporary directory at runtime. Disable tools when Redline's review policy requires it.

No image build has been run locally. Multi-platform build validation remains for Linux CI.
