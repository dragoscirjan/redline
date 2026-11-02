# @dragoscirjan/redline

## 1.2.2

### Patch Changes

- a8b4955: Publish the tested native Docker images by digest and combine their manifests after both architectures pass. Remove the redundant QEMU rebuild that timed out after npm publication, while preserving matching versions, SBOM and provenance attestations.

## 1.2.1

### Patch Changes

- 54552e4: Build the pinned GitNexus parser and grammar bindings from source during Docker image construction. This fixes missing or mislabeled ARM64 prebuilds without enabling runtime compilation or unrelated install scripts.

## 1.2.0

### Minor Changes

- e22ab88: Add a Docker image that runs Redline with Node, Bun, Python, Pi, OpenCode and the requested MCP dependencies. Keep the existing CLI and native harness execution unchanged; Docker is invoked externally with read-only repository and writable output/cache mounts.
  
  Respect XDG_CACHE_HOME for persistent provider indexes, and build and publish the image through a standard GHCR workflow only after a successful new npm publication, with the matching package version tag.

## 1.1.0

### Minor Changes

- 341f444: Add a versioned editor-neutral JSON-RPC protocol over stdio with bounded messages, review lifecycle and cancellation, paged validated results, committed schemas and reference-client conformance tests. Preserve existing review CLI behavior and model policy.
