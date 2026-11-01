# Run Redline with Docker

The image runs **Redline itself**, with Node, Bun, Python, Pi, OpenCode and the
requested MCP packages installed. You run Docker; Redline does not start containers.
No Docker daemon or socket is needed inside the image.

## Build

CI builds only after a new npm version is published. To reproduce an image locally,
use a trusted checkout of that published version's release commit:

```bash
docker build --file containers/Dockerfile --tag redline:dev .
docker run --rm redline:dev --help
```

The entrypoint is `node /opt/redline/bin/redline.mjs`. Arguments after the image name
are normal Redline CLI arguments. There are no `--isolation` or `--container-image`
options in Redline.

The pinned runtimes are Node24.21.0, Bun1.4.4 and Python3.12. Pi1.4.0,
OpenCode1.18.34, CGC0.5.7, GitNexus1.6.12, context-mode1.0.169 and
sequential-thinking2.0.0 are installed during the trusted image build.
GitNexus uses the PolyForm Noncommercial license; check its terms before use.

MCP packages are installed and their server startup is tested. Exposing the approved
read-only MCP tools to the review LLM is still tracked in
[issue #209](https://github.com/dragoscirjan/redline/issues/209). Installation alone
does not enable model tool access.

## Review a repository

Keep cache and output directories outside the repository. Export
`REDLINE_MODEL_AUTH` through your normal secret mechanism, then run:

```bash
CACHE="$HOME/.cache/redline-docker"
OUTPUT="$HOME/.local/state/redline-docker"
mkdir -p "$CACHE" "$OUTPUT"

docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 2g --cpus 2 --pids-limit 256 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777 \
  --mount "type=bind,src=$PWD,dst=/repository,readonly" \
  --mount "type=bind,src=$CACHE,dst=/cache" \
  --mount "type=bind,src=$OUTPUT,dst=/output" \
  --env REDLINE_MODEL_AUTH \
  redline:dev review \
  --repository /repository --base main --head HEAD \
  --harness pi --provider openrouter \
  --endpoint https://openrouter.ai/api/v1 --model YOUR_MODEL \
  --output "/output/run-$(date +%s)"
```

Use `--harness opencode` to select OpenCode. The existing executors launch the
installed binaries normally inside the container. Prompts, reasoning, retry policy
and authoritative finding validation use the same review engine as the npm CLI.

The example maps your non-root host UID/GID so Git ownership and writable mounts
work without permission changes. The image defaults to UID/GID10001. When using
named volumes, make sure your chosen runtime user can write them.

Only reviewed data is mounted at `/repository`; it is read-only. Redline never
executes repository scripts, builds, installers or hooks. Its generated configuration
and captured snapshots live in container scratch/output directories.

## Persistent caches and GitHub Actions

`/cache` and `/output` are declared volumes. `XDG_CACHE_HOME=/cache` directs both
CGC and GitNexus retained index data to `/cache/redline/indexes/v1`, separate from
per-run state and model credentials. Entries remain keyed by repository/base,
provider/version, platform and index configuration, with validation before reuse.

Bind a host directory to `/cache` to retain data across containers. GitHub Actions
can restore/save that host directory with `actions/cache`. The Docker CI workflow
does this at `${{ runner.temp }}/redline-code-index/cache` and proves that each
real provider reuses its data in a second Redline container. The existing code-index
Action's cache restore/save contract is unchanged.

For RPC, run `docker run --rm -i [mounts and environment] IMAGE rpc [settings]`.
Do not allocate a TTY for framed stdio RPC.

## Publishing and limits

The npm release workflow calls `.github/workflows/docker.yml` only after it
publishes a new version and verifies the installed package. A 30-second grace period
after publication gives the npm registry time to propagate before that verification.
This wait does not guarantee registry availability; a failed verification blocks
Docker builds.

The Docker workflow checks out the exact release commit and verifies that its
package version matches the published version before building. It copies that
release source into the image, so it does not need another npm install.

Native Linux amd64 and arm64 builds and container tests run at this point. After
both pass, the workflow publishes `ghcr.io/dragoscirjan/redline:VERSION`, with the
same version as the npm package and an OCI version label. Ordinary pushes, pull
requests, version-PR creation and no-op releases do not build images. Action tags
remain separate.

If GHCR initially makes the package private, the owner must make it public for
anonymous pulls. Use an image digest when you need an immutable reference.

Docker flags, mounts and resource limits belong to the outer Docker invocation,
not to Redline. Docker shares the host kernel and trusts its administrator and daemon.
It does not protect against a malicious host or guarantee protection from kernel escapes.
