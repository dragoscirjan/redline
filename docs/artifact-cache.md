# Artifact cache and tool acquisition contracts

Redline's artifact-cache layer defines forge-independent contracts for exact review-tool acquisition and safe reuse of immutable analysis artifacts. Caching is an optimization: a miss, bypass, stale entry, corruption, or backend failure never changes the required review work or silently converts unavailable analysis into an empty result.

## Current implementation status

This milestone provides:

- versioned review-tool descriptors and installed-tool manifests;
- provider-neutral `ToolInstaller` contracts, an immutable installer registry, and a restore/validate/reinstall acquisition manager;
- pinned GitNexus and CodeGraphContext installer adapters with immutable distributions and executable health checks;
- digest-bound identities for downloaded tools, installed tools, code-index snapshots, normalized queries, graph deltas, change-impact maps, and context plans;
- strict artifact-manifest parsing and deterministic compatibility keys;
- an explicit no-cache backend;
- a local-filesystem backend with validated restore, atomic publication, inter-writer locking, stale-lock recovery, corruption eviction, expiry, and bounded retention;
- operation-level status, byte counts, elapsed time, and bounded diagnostics.

Concrete Pi and OpenCode installers are not implemented by this milestone. The GitHub Actions cache adapter, code-index snapshot integration, review-runner wiring, aggregate performance metrics, and cold-versus-warm benchmarks also remain future #111 work.

## Tool descriptors

A `ReviewToolDescriptor` binds an exact tool to all acquisition and compatibility inputs:

- tool family and stable tool/provider identity;
- exact tool version and distribution source;
- immutable SHA-256 or SHA-512 distribution digest when available;
- applicable license and redistribution metadata;
- installer recipe version;
- operating system and architecture;
- runtime versions and ABI requirements;
- grammar and feature sets;
- a bounded executable health/version probe.

`reviewToolDescriptorDigest` changes when any of these fields changes. Download and installed-tool cache identities use that digest, so a tool version, recipe, ABI, platform, grammar, feature, distribution, or licensing change cannot reuse the previous artifact identity.

`InstalledToolManager` tries a validated restore first. A missing, bypassed, corrupt, incompatible, backend-error, or timed-out cache result falls back to installation. Cache operations have a separate bounded budget and restore into an isolated staging path, so an abandoned backend cannot later overwrite the selected installation. A restored tree must match its file manifest and pass an exact pinned-version probe; otherwise it is evicted and reinstalled. New installations are validated before optional cache publication. Cache failures are retained as warnings and never prevent a successfully acquired required tool from being used.

The built-in code-indexer registry contains GitNexus and CodeGraphContext adapters. Adding another tool requires an adapter and registration rather than branching in harness, review, publication, or code-intelligence domains.

## Pinned code-indexer distributions

GitNexus is pinned to `1.6.12`. Acquisition verifies the published npm archive SHA-512 digest, separately verifies the tagged upstream `package-lock.json`, extracts the archive with an argument-array `tar` invocation, and runs `npm ci` with development dependencies, bin links, and all lifecycle scripts disabled. The installer activates LadybugDB by copying the matching digest-locked platform binding, removes the optional embedding packages, and validates native database and tree-sitter imports through a generated health probe. No dependency script can perform an unverified secondary download or build. The dependency-lock digest, disabled optional embedding stack, exact Node version, and Node module ABI are compatibility inputs. GitNexus remains subject to the PolyForm Noncommercial License; Redline records redistribution as conditional and does not repackage it.

CodeGraphContext is pinned to `0.5.7`. Acquisition uses the upstream standalone release binaries and published SHA-256 digests for Linux x64, macOS arm64, and Windows x64. Unsupported platform/architecture combinations fail explicitly. CodeGraphContext is MIT-licensed and its descriptor records redistribution as allowed.

## Artifact identities

Every cache key is derived from a strict typed identity and has the form:

```text
v1/<artifact-kind>/<sha256-of-canonical-identity>
```

Code-index identities combine the provider compatibility digest and immutable snapshot compatibility digest introduced by the code-intelligence layer. They also include storage format and optional platform identity. Therefore a repository revision, source-tree digest, provider version, adapter/schema contract, configuration, capability set, storage format, or required platform change creates a different key.

Derived artifacts require sorted named SHA-256 inputs plus their own contract version. Callers must include every semantic input. Mutable branch names and arbitrary undigested values are not part of the identity contract. Model findings and verdicts are not cacheable under this first contract.

## Manifests and validation

A cached directory is immutable after publication. Its manifest records:

- the full typed identity and identity digest;
- the derived cache key;
- every regular file's normalized relative path, SHA-256 digest, byte count, and portable permission bits;
- a digest of the sorted file manifest;
- creation and optional expiry time.

Restore validates the manifest, identity, expiry, top-level layout, every file digest and size, and every permission mode before copying. The restored tree is validated again and atomically renamed into a destination that must not already exist. Incompatible, stale, or corrupt artifacts are never restored; restore evicts them so required work can rebuild cleanly.

Symbolic links, non-regular files, nested empty directories, and directory modes other than `0755` are rejected in this initial backend because the file manifest cannot reproduce them exactly. Artifact source and destination paths are trusted host configuration and must never be selected by pull-request content.

## Local filesystem backend

`LocalFilesystemArtifactCache` publishes through a temporary sibling directory and one atomic rename. A per-key owner lease with a heartbeat serializes concurrent publishers, including publishers in separate cache instances. A stale lease is reclaimed only when its recorded local process is no longer alive. Temporary and lock paths are not valid cache entries and interrupted publication cannot expose a complete-looking artifact.

Retention supports maximum age, entry count, and payload bytes. Pruning reclaims stale interrupted-publication directories and retired stale-lock directories, removes expired and corrupt entries, then removes the oldest immutable entries until all configured bounds are satisfied. Fresh or actively locked publication work is preserved. Eviction affects performance only; it never changes normalized inputs or review decisions.

The backend returns explicit `hit`, `miss`, `stale`, `incompatible`, `corrupt`, `bypassed`, and `error` states. Save, remove, and prune operations similarly report outcomes instead of pretending cache work succeeded.

## No-cache backend

`NoopArtifactCache` returns `bypassed` for every operation and writes nothing. It is the correctness baseline for environments where caching is disabled or unavailable. Callers continue with installation, indexing, or derivation exactly as they would after a miss.

## Security boundary

Cache roots, tool descriptors, installer registrations, artifact identities, and filesystem destinations are trusted workflow configuration. Repository and pull-request content remain untrusted data and cannot alter keys, installer recipes, executable probes, cache paths, or health checks.

Cache metadata contains no credentials. The current public-distribution installers require trusted absolute Node, npm, and tar executable paths plus an explicitly constructed environment from the composition layer; they do not read ambient `PATH` or package-manager credentials. Downloads require HTTPS, have byte and time bounds, and are digest-verified before execution or extraction. Installer and health processes use the neutral shared bounded process runner, argument arrays, bounded output, and hard timeouts. Installed trees reject symbolic links and unsupported file types before caching.
