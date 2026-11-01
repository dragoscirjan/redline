# Docker workers

Docker isolation is **opt-in** for Pi and OpenCode on native Linux amd64 and arm64.
Direct execution remains the default on the six supported CLI platforms.
An unavailable Docker engine, image or security control fails the requested review;
Redline never falls back to a host harness.

Only the harness runs in the container. Git capture, indexing, caches, finding validation,
artifacts, CLI/RPC and forge publication stay on the trusted host.

## Build both images from source

From a trusted Redline checkout with Node.js 24, Docker Engine and Buildx available:

```bash
mise exec -- node src/harness-worker/build.ts --output /tmp/redline-workers
```

The output directory must be new or empty. The command builds both native variants,
loads them into the local engine and prints the path to `worker-manifest.json`.
It uses a uniquely named temporary BuildKit builder and removes only that builder.
It does not change your default builder, install a host SDK or publish an image.

Run the source CLI with this manifest, outside the repository being reviewed:

```bash
node bin/redline.mjs review \
  --repository /path/to/repository \
  --config /outside-reviewed-repository/redline-config.json \
  --harness pi --isolation docker \
  --worker-manifest /tmp/redline-workers/worker-manifest.json \
  --indexing disabled
```

Use `--harness opencode` for the other variant. Model configuration and authentication
use the existing [trusted configuration](https://dragoscirjan.github.io/redline/get-started/configuration).
The SDK connects to the configured provider through Docker bridge networking. An endpoint
on `127.0.0.1` means the **container**, not the host. For a host-local model, use
`host.docker.internal` and bind the service to a trusted interface reachable from Docker;
host firewall rules must permit that connection. Redline does not enable host networking.

For OCI archives as well as locally loaded images, add `--oci`. Release builds also
use `--release`, which requires an exact clean source commit:

```bash
mise exec -- node src/harness-worker/build.ts \
  --release --oci --output /tmp/redline-worker-candidates
```

The supported Dockerfile is `containers/Dockerfile`, with targets `pi` and `opencode`.
Both keep the pinned Node.js base and include Bun 1.4.4 from an immutable amd64/arm64
donor image. `bun` and `bunx` are available; no host runtime installation is changed.
The older `packages/*-runner/Dockerfile` files are references, not this implementation.
You can build an individual development target directly:

```bash
docker build --file containers/Dockerfile --target pi \
  --build-arg REDLINE_REVISION="$(git rev-parse HEAD)" \
  --tag redline-pi:dev .
docker build --file containers/Dockerfile --target opencode \
  --build-arg REDLINE_REVISION="$(git rev-parse HEAD)" \
  --tag redline-opencode:dev .
```

These tags are local conveniences, not accepted runtime identities. Prefer the build
helper: it creates a manifest containing immutable image IDs. The image entrypoint is
a small script that prepares private writable SDK state and execs the existing binary.
Redline supplies the same non-interactive arguments and parses the same SDK output.

## Use a released package

A coordinated release embeds exact matching GHCR index digests in the npm package:

- `ghcr.io/dragoscirjan/redline-pi`
- `ghcr.io/dragoscirjan/redline-opencode`

With such a package, use `redline review --harness pi --isolation docker` and your
normal trusted model settings. No host Pi/OpenCode installation is needed. Do not
supply a development manifest for normal released use. There is no `latest` selection,
floating fallback or third published base image.

A source checkout contains an unreleased manifest placeholder until release assembly.
Use the local build manifest for source execution. npm 1.0.0 and 1.1.0 are not backfilled
with invented images; this feature is delivered only in a new product version.
See [coordinated releases](./coordinated-releases.md) for publication and recovery.

## Trusted settings and limits

The same startup settings apply to `redline review` and `redline rpc`:

| Setting | Default | Allowed range |
| --- | --- | --- |
| `--isolation` | `direct` | `direct`, `docker` |
| `--container-memory` | 1024 MiB | 256–8192 MiB |
| `--container-scratch` | 256 MiB | 64–1024 MiB |
| `--container-cpus` | 1 | 0.25–4 |
| `--container-pids` | 128 | 32–512 |

The corresponding local environment names are `REDLINE_ISOLATION`,
`REDLINE_WORKER_MANIFEST`, `REDLINE_CONTAINER_MEMORY`, `REDLINE_CONTAINER_SCRATCH`,
`REDLINE_CONTAINER_CPUS` and `REDLINE_CONTAINER_PIDS`. Trusted JSON configuration
uses the same kebab-case names as the flags, with string values. Normal precedence
is flags → supported environment → trusted outside-repository configuration → defaults.
Container-only settings require Docker mode.

RPC requests cannot select isolation, image manifests, limits, credentials, endpoints
or Docker flags. Configure these when starting the server. The current GitHub Action
surface is not rewired here; that separate milestone consumes the shared executor.

Limits are **per invocation**, so concurrent workers add their resource use. Each file
attempt and each outer retry gets a fresh container. Host reuse remains available,
but direct and Docker execution identities do not share cached semantic results.
The existing run deadline, file timeouts, validation and model budgets still apply.
Pi caller-managed execution makes one provider request per attempt; OpenCode 1.18.34
can make six because its five native retries remain intact. Reasoning is not disabled.

## Security boundary

Workers run with UID/GID 10001, a read-only root filesystem, private IPC/cgroup namespaces,
no capabilities, no-new-privileges and Docker's built-in seccomp profile. They have
bounded CPU, memory, PIDs and a noexec/nosuid/nodev writable tmpfs; swap is disabled.
Unsupported enforcement fails preflight rather than silently reducing protection.

The only host bind mount is a read-only staging directory containing that invocation's
generated configuration and fixed policy. It never contains a repository checkout,
Docker socket, SSH agent, ambient credentials or host HOME. The SDK receives only the
selected model-provider credential: Pi uses its existing environment interpolation;
OpenCode uses its existing generated configuration. No GitHub token or unrelated
provider credential is forwarded. The Docker daemon can inspect this selected key.

Bridge networking permits the SDK's provider connection; it is not an endpoint allowlist.
There is no custom worker protocol, model relay or host credential broker. Bounded stdin
and stdout carry the existing harness input/output. Existing host redaction protects
persisted diagnostics and artifacts, not the SDK's access to its own selected key.

The SDK's tools remain disabled. Untrusted source stays prompt data; it does not
select executables, permissions, prompts or publication policy. The host validator
still decides whether findings match the authoritative diff. A constrained transport
and a successful mock response do not prove model accuracy.

Docker shares the host kernel. This boundary trusts the host administrator, controller,
Docker daemon and kernel; it is not malicious-host protection or a kernel-escape guarantee.
Docker Desktop on macOS/Windows is not certified by Linux image builds. Use direct mode
there unless a later compatibility milestone certifies that environment.

## Cleanup and evidence

Normal completion, cancellation and failure stop and remove the owned container. Later preflight reconciles only expired containers with the matching
Redline marker and owner labels. Redline never runs a global prune or deletes unrelated
resources. A dead controller cannot guarantee immediate deletion.

The opt-in native container suite uses real pinned SDKs and a synthetic model container
on the Docker bridge, with no published host port or paid provider. It
covers CLI/RPC findings, request-controlled isolation rejection, retry ownership,
fatal authentication, reflected-key redaction, cancellation and the actual kernel,
network, mount and cgroup profile. Native arm64 CI is required separately; amd64 success
or emulation alone is not arm64 certification. No live-provider quality claim follows
from these tests.
