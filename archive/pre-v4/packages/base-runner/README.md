# Base runner image

`Dockerfile` defines the common Node.js runtime and unprivileged user for the Pi and OpenCode runner images in `packages/base-runner/`. The harness images build from the same base reference, then install only their own CLI and required operating-system packages.

The default reference is the official `node:24-bookworm-slim` multi-platform image. Override `NODE_BASE` to an approved digest at release time. Debian slim is used because CodeGraphContext's `falkordblite` dependency compiles Redis during installation and relies on glibc-compatible native Python packages. A build toolchain is installed temporarily to compile it, then removed before the base image is finalized. CI builds for both `linux/amd64` and `linux/arm64`.

## MCP database storage

MCP packages live in `/opt/redline/mcp`. Persistent indexes and databases must not live in the image layer. The image creates writable data directories for UID/GID 10001 under `/var/lib/redline/mcp`:

- GitNexus: `/var/lib/redline/mcp/gitnexus`, selected with `GITNEXUS_STORAGE_ROOT`.
- CodeGraphContext: config, data, and cache subdirectories under `/var/lib/redline/mcp/codegraphcontext`, selected with XDG environment variables. Confirm the selected database backend honors these locations before relying on the mount layout.

Mount the host-managed cache directory at `/var/lib/redline/mcp` and set it writable for UID/GID 10001. Use separate cache directories per repository and architecture. Do not share a writable database between concurrent containers unless its backend documents safe concurrent access. Include the canonical repository identity, index schema version, MCP package versions, and `linux/amd64` or `linux/arm64` in the cache key. Native database files may not be portable across architectures. Treat restored caches as untrusted data. Do not execute programs from them, and isolate caches from untrusted pull request runs.

Sequential Thinking has no database. context-mode may keep its own local state; it has no external cache mount configured here yet. Inspect its storage contract before adding one.

The base includes no repository checkout, model runtime, credentials, or review policy. The trusted caller must still disable backend tools under Redline's review policy and provide credentials only through the approved credential gateway.
