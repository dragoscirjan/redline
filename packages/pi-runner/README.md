# Pi runner image

Build and push the shared base first, then build and push the harness image from the repository root with BuildKit/buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/base-runner/Dockerfile \
  --build-arg NODE_BASE=node:24-bookworm-slim \
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

The image runs as UID/GID 10001. It contains no checkout or credentials. MCP packages and the development settings file remain in the image, but the review bootstrap does not load that settings file. The bootstrap creates an empty settings file and a one-provider model file under `/tmp/redline/run`, then starts Pi with tools and project resource discovery disabled and project-local files ignored (`--no-approve`), because the source volume is read-only and project settings must never influence the review.

The image entrypoint is `/opt/redline/bootstrap.js`. It accepts one bounded host-generated envelope through stdin and rejects arbitrary native configuration. The selected model credential remains out of process arguments and generated files. `GH_TOKEN` and the complete credential map never enter the container.

Run reviews with Pi JSON event output. Trusted host code extracts assistant `text_delta` events and parses `redline-review-events/v1` lines. This reporting path does not add a Pi tool or expose forge credentials to the container.

A local `linux/amd64` image build and controlled fake-endpoint smoke run pass. Multi-platform build validation remains for Linux CI.

The review action consumes this image only through the digest pinned for the `pi` backend in `src/runner-images.ts` in the Redline repository. The pinned reference is the multi-platform manifest digest pushed by CI; `latest` and tag references are never used by the action. Redline's internal dogfood pipeline may build this image from trusted source and run it by the resulting local image ID.
