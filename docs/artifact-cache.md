# Artifact cache and tool acquisition contracts

Redline's artifact-cache layer defines forge-independent contracts for exact review-tool acquisition and safe reuse of immutable analysis artifacts. Caching is an optimization: a miss, bypass, stale entry, corruption, or backend failure never changes the required review work or silently converts unavailable analysis into an empty result.

## Current implementation status

This milestone provides:

- versioned review-tool descriptors and installed-tool manifests;
- provider-neutral `ToolInstaller` contracts and an immutable installer registry;
- digest-bound identities for downloaded tools, installed tools, code-index snapshots, normalized queries, graph deltas, change-impact maps, and context plans;
- strict artifact-manifest parsing and deterministic compatibility keys;
- an explicit no-cache backend;
- a local-filesystem backend with validated restore, atomic publication, inter-writer locking, stale-lock recovery, corruption eviction, expiry, and bounded retention;
- operation-level status, byte counts, elapsed time, and bounded diagnostics.

Concrete Pi, OpenCode, GitNexus, and CodeGraphContext installers are not implemented by this milestone. The GitHub Actions cache adapter, runner wiring, aggregate performance metrics, and cold-versus-warm benchmarks also remain future #111 work.

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

The installer registry contains no built-in installers yet. Adding a tool requires an adapter and registration rather than branching in harness, review, publication, or code-intelligence domains.

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

Cache metadata contains no credentials. Tool installers must receive only the credentials explicitly selected for acquisition, must not persist them in installed trees or manifests, and must validate restored executables before use. Those concrete installer and health-check implementations are deferred to the next #111 slice.
