# Run Redline with Docker

Use the published image to run Redline with its runtimes and harnesses already installed. You do not need to clone Redline or build an image.

The documented runtime is native Linux on amd64 or arm64 with Docker. You also need a Git checkout with a committed `HEAD`, tracked changes and a model-provider credential. The example assumes the checkout's Git metadata is inside the mounted directory, as in a standalone clone.

## Get the published image

```bash
docker pull ghcr.io/dragoscirjan/redline:1.2.2
docker run --rm ghcr.io/dragoscirjan/redline:1.2.2 --help
```

Docker selects the matching architecture. Browse available versions on [GitHub Packages](https://github.com/users/dragoscirjan/packages/container/package/redline). Use a version tag, or an image digest when you need an immutable reference.

The image runs Redline itself and includes Node, Bun, Python, Pi, OpenCode and the requested MCP packages. Redline does not start containers, and no Docker daemon or socket is needed inside the image. The bundled GitNexus package uses the PolyForm Noncommercial license; check its terms before use.

## Review a repository

Open a terminal in the checkout you want to review as your regular, non-root user. Keep cache and output directories outside that checkout.

Provide `REDLINE_MODEL_AUTH` through your normal secret mechanism. It is a provider-keyed JSON object; for the OpenRouter example below its shape is:

```json
{"openrouter":"YOUR_API_KEY"}
```

Replace `YOUR_MODEL_ID` in the command with an available model ID. Model reviews send captured source to your selected provider and can incur charges. Do not pass GitHub or other unrelated credentials into the container.

```bash
CACHE="$HOME/.cache/redline-docker"
OUTPUT="$HOME/.local/state/redline-docker"
RUN="run-$(date +%s)"
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
  ghcr.io/dragoscirjan/redline:1.2.2 review \
  --repository /repository --indexing disabled \
  --harness pi --provider openrouter \
  --endpoint https://openrouter.ai/api/v1 --model YOUR_MODEL_ID \
  --output "/output/$RUN"
```

This reviews staged and unstaged tracked changes against `HEAD`. Use `--harness opencode` to select OpenCode. Arguments after the image name are normal [Redline CLI options](/local-cli), so you can also choose branches or commits with `--base` and `--head`.

`--indexing disabled` keeps the first review independent of index preparation. Remove it to attempt the bundled default indexer; the cache mount retains validated provider data across containers. Context coverage remains explicit.

The command maps your non-root host UID/GID so Git ownership and writable mounts work without permission changes. The image defaults to UID/GID10001. With named volumes, make sure your chosen runtime user can write them.

Only reviewed data is mounted at `/repository`; it is read-only. Redline never executes repository scripts, tests, builds, installers or hooks. Generated configuration and captured snapshots live in container scratch/output directories. Review reasoning, retries and finding validation use the same engine as the npm CLI.

## Read the results

Check findings and coverage in the terminal. The output bind mount keeps reports on the host after the container exits:

- `$OUTPUT/$RUN/reviews/review.md` contains the consolidated review.
- `$OUTPUT/$RUN/reviews/summary.json` contains coverage and run details.

Review suggestions before acting on them. No findings with failed or omitted required files is not a complete review. See [Read the results](/results) for the other files and exit codes.

## Persistent caches and GitHub Actions

`/cache` and `/output` are declared volumes. `XDG_CACHE_HOME=/cache` directs both
CGC and GitNexus retained index data to `/cache/redline/indexes/v1`, separate from
per-run state and model credentials. Entries remain keyed by repository/base,
provider/version, platform and index configuration, with validation before reuse.

Bind a host directory to `/cache` to retain data across containers. GitHub Actions
can restore/save that host directory with `actions/cache`. The Docker CI workflow
does this at `$RUNNER_TEMP/redline-code-index/cache` and proves that each
real provider reuses its data in a second Redline container. The existing code-index
Action's cache restore/save contract is unchanged.

For RPC, run `docker run --rm -i [mounts and environment] IMAGE rpc [settings]`.
Do not allocate a TTY for framed stdio RPC.

## Publishing and limits

The npm release workflow calls `.github/workflows/docker.yml` only after it
publishes a new version and verifies the installed package. A 30-second grace period
after publication gives the npm registry time to propagate before that verification.
Package installation allows up to five attempts, with 15 seconds between failures,
and uses `--prefer-online` to revalidate cached metadata. The CLI smoke runs only
after installation succeeds. If installation or verification still fails, Docker
builds remain blocked.

The Docker workflow checks out the exact release commit and verifies that its
package version matches the published version before building. It copies that
release source into the image, so it does not need another npm install.

Each native Linux amd64 and arm64 runner builds and loads its image, then runs the
container tests. After its tests pass, the same runner exports the cached image by
digest with SBOM and provenance attestations. Both exports use the release commit's
timestamp, and a matching image-config digest proves that the exported runtime is
the one tested. Registry login happens after the harness tests.

Once both native jobs pass, `docker buildx imagetools create` combines their digest
references into `ghcr.io/dragoscirjan/redline:VERSION`, with the same version as the
npm package and an OCI version label. This final job does not rebuild images or use
QEMU. It preserves the native images and their attestations. Ordinary pushes, pull
requests, version-PR creation and no-op releases do not build images. Action tags
remain separate.

If GHCR initially makes the package private, the owner must make it public for
anonymous pulls.

Docker flags, mounts and resource limits belong to the outer Docker invocation,
not to Redline. Docker shares the host kernel and trusts its administrator and daemon.
It does not protect against a malicious host or guarantee protection from kernel escapes.

## Optional source build {#build}

Contributors can reproduce the image from a trusted Redline checkout at a published version's release commit. This is not needed to use the published image.

```bash
docker build --file containers/Dockerfile --tag redline:dev .
docker run --rm redline:dev --help
```

To use your local build, substitute `redline:dev` for the published image in the review command. The entrypoint is `node /opt/redline/bin/redline.mjs`; Redline has no `--isolation` or `--container-image` flags.

The pinned runtimes are Node24.21.0, Bun1.4.4 and Python3.12. Pi1.4.0,
OpenCode1.18.34, CGC0.5.7, GitNexus1.6.12, context-mode1.0.169 and
sequential-thinking2.0.0 are installed during the trusted image build.
The pinned tree-sitter parser and grammars are built from source with C++20 for
Node24, because their Linux ARM64 prebuilds are missing or mislabeled. Only these
packages receive build approval; general install scripts and esbuild remain
disabled. Compilers are removed afterward, and nothing compiles during a review.

MCP packages are installed and their server startup is tested. Exposing the approved
read-only MCP tools to the review LLM is still tracked in
[issue #209](https://github.com/dragoscirjan/redline/issues/209). Installation alone
does not enable model tool access.
