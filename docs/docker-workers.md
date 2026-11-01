# Docker harness image

Docker mode runs Pi or OpenCode in one shared image. Redline stays on the host for
Git capture, review control, validation and output. Direct execution remains the default.

## Build and run

From a trusted Redline checkout:

```bash
docker build --file containers/Dockerfile --tag redline-harnesses:dev .
node bin/redline.mjs review \
  --repository /path/to/repository \
  --config /outside-reviewed-repository/redline-config.json \
  --harness pi --isolation docker \
  --container-image redline-harnesses:dev
```

Use `--harness opencode` to select OpenCode from the same image. No host harness
installation is needed. The image includes Node 24.21.0, Bun 1.4.4, both harnesses,
CodeGraphContext, GitNexus, context-mode and sequential-thinking packages. Package
versions are pinned in the image dependency manifests and lockfiles.

The read-only MCP configuration and persistent index-cache mounts are still being
implemented in [issue #209](https://github.com/dragoscirjan/redline/issues/209).
Installing a package does not by itself expose its tools to the review model.
GitNexus uses the PolyForm Noncommercial license; check its terms before using the image.

## Configuration

`--container-image` accepts a trusted image tag or digest. Redline resolves it to a
local immutable image ID before execution. That ID also separates review-cache
entries. There is no release manifest or automatic image/package version coupling.
The equivalent trusted environment setting is `REDLINE_CONTAINER_IMAGE`.

The startup settings apply to both CLI and RPC. A review request cannot change
isolation, image selection, model credentials or resource limits.

| Setting | Default | Allowed range |
| --- | --- | --- |
| `--isolation` | `direct` | `direct`, `docker` |
| `--container-memory` | 1024 MiB | 256–8192 MiB |
| `--container-scratch` | 256 MiB | 64–1024 MiB |
| `--container-cpus` | 1 | 0.25–4 |
| `--container-pids` | 128 | 32–512 |

## Boundary

Containers run non-root, with a read-only root filesystem, dropped capabilities,
no-new-privileges, built-in seccomp, private IPC/cgroup namespaces and bounded
writable temporary storage. CPU, memory and process limits apply per invocation.
Docker mode fails if the engine cannot enforce the required profile. It never
falls back to a host harness.

Only private generated configuration and the fixed policy enter the read-only input
mount. The selected provider credential enters the container through the existing
harness configuration. No working-repository mount, host HOME, Docker socket,
GitHub token or unrelated host credential is forwarded.

The existing executor constructs input and parses the SDK's output. There is no
custom worker protocol, model relay or credential broker. Reasoning, retry ownership,
timeouts and authoritative finding validation remain in the existing review flow.

Bridge networking permits provider connections. Container `127.0.0.1` is not the
host. A host-local service must listen on a trusted Docker-reachable interface;
`host.docker.internal` names the host gateway. Host firewall rules still apply.

Docker trusts the host administrator, daemon and kernel. It is not protection from
a malicious host or a kernel escape. Native Linux amd64 and arm64 are the image
targets; Docker Desktop compatibility is not claimed.

Normal completion, failure and cancellation remove only the owned container. Later
preflight can reconcile expired owned containers. A dead controller cannot guarantee
immediate cleanup. Redline never runs a global prune.

## Publishing

`.github/workflows/docker.yml` builds and tests the image on native amd64 and arm64.
Only a push to this repository's `main` can publish the shared multi-architecture image
as `ghcr.io/dragoscirjan/redline-harnesses`, tagged `main` and with its source commit.
Use the digest printed by the build when you need an immutable external reference.
The workflow uses standard Docker actions. npm publishing remains independent and
unchanged. No image has been published by this implementation session.
