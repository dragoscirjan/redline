# @dragoscirjan/redline

## 1.3.0

### Minor Changes

- 5a689b7: Use installed Pi/OpenCode CLI entry points and normal global/checkout-local configuration for local CLI and Docker reviews. Keep configured MCPs, plugins and extra tools available. Warn prominently for unsandboxed CLI execution, retain isolated read-only Actions execution, and record native server/tool observations separately from actual successful calls.
  
  Add native MCP defaults to the image without replacing supplied configuration, fix the development tee-logging script and linked-worktree Docker mounts, and preserve authoritative findings, model reasoning, deadlines, provider caches and publication-token separation. Native model-result reuse is disabled because external tool/configuration state cannot be proven unchanged. Run a bounded model-mediated startup warmup to discover native tools, prepare/query captured-head indexes, report warnings before file work and guide later prompts without changing tool permissions. Add explicit live-progress controls for tee logging. Prompt policy is now v12. Separate optional tool checks from selected-provider indexing, require observed setup work instead of accepting invented readiness, and include source-validated code-impact notes for changed symbols and unchanged callers in native reports. Correct failed-index rebuild reporting and keep verified offline CGC grammars for isolated preparation.

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
