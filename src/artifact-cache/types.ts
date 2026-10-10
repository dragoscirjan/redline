/** Provider-neutral contracts for review tool acquisition and immutable artifact caches. */

export const ARTIFACT_CACHE_CONTRACT_VERSION = 1 as const;
export const REVIEW_TOOL_DESCRIPTOR_VERSION = 1 as const;
export const ARTIFACT_MANIFEST_VERSION = 1 as const;
export const INSTALLED_TOOL_MANIFEST_VERSION = 1 as const;

export type ContentDigest = `sha256:${string}` | `sha512:${string}`;
export type Sha256Digest = `sha256:${string}`;

export type ReviewToolFamily = 'harness' | 'code-indexer';

export interface ReviewToolLicense {
  readonly name: string;
  readonly spdx: string | null;
  readonly url: string;
  readonly redistribution: 'allowed' | 'conditional' | 'prohibited' | 'unknown';
  readonly notice?: string;
}

export interface ReviewToolDistribution {
  readonly source: string;
  readonly digest?: ContentDigest;
}

export interface ToolPlatform {
  readonly operatingSystem: string;
  readonly architecture: string;
}

export interface ToolRuntimeRequirement {
  readonly name: string;
  readonly version: string;
  readonly abi?: string;
}

export interface ToolHealthProbe {
  /** Repository-relative executable path inside the installed tool directory. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly expectedExitCode: number;
  readonly expectedOutput?: string;
}

export interface ReviewToolDescriptor {
  readonly version: typeof REVIEW_TOOL_DESCRIPTOR_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly family: ReviewToolFamily;
  /** Required for code indexers; omitted for harness tools. */
  readonly providerId?: string;
  readonly toolVersion: string;
  readonly distribution: ReviewToolDistribution;
  readonly license: ReviewToolLicense;
  readonly installerRecipeVersion: string;
  readonly platform: ToolPlatform;
  readonly runtimes: readonly ToolRuntimeRequirement[];
  readonly grammars: readonly string[];
  readonly features: readonly string[];
  readonly healthProbe: ToolHealthProbe;
}

export interface ArtifactFileEntry {
  readonly path: string;
  readonly digest: Sha256Digest;
  readonly bytes: number;
  /** Portable permission bits, restricted to 0o000 through 0o777. */
  readonly mode: number;
}

export interface InstalledToolManifest {
  readonly version: typeof INSTALLED_TOOL_MANIFEST_VERSION;
  readonly descriptorDigest: Sha256Digest;
  readonly payloadDigest: Sha256Digest;
  readonly files: readonly ArtifactFileEntry[];
  readonly executablePaths: readonly string[];
}

export type ToolArtifactKind = 'tool-download' | 'installed-tool';

export interface ToolArtifactIdentity {
  readonly version: typeof ARTIFACT_CACHE_CONTRACT_VERSION;
  readonly kind: ToolArtifactKind;
  readonly descriptorDigest: Sha256Digest;
}

export interface CodeIndexArtifactIdentity {
  readonly version: typeof ARTIFACT_CACHE_CONTRACT_VERSION;
  readonly kind: 'code-index-snapshot';
  readonly providerCompatibilityDigest: Sha256Digest;
  readonly snapshotCompatibilityDigest: Sha256Digest;
  readonly storageFormat: string;
  /** Include platform identity only when the provider storage format requires it. */
  readonly platform?: ToolPlatform;
}

export type DerivedArtifactKind =
  | 'normalized-query'
  | 'graph-delta'
  | 'change-impact-map'
  | 'context-plan';

export interface NamedArtifactInput {
  readonly name: string;
  readonly digest: Sha256Digest;
}

export interface DerivedArtifactIdentity {
  readonly version: typeof ARTIFACT_CACHE_CONTRACT_VERSION;
  readonly kind: DerivedArtifactKind;
  readonly contractVersion: string;
  /** Complete, sorted digest-bound inputs for this derivation. */
  readonly inputs: readonly NamedArtifactInput[];
}

export type ArtifactIdentity =
  | ToolArtifactIdentity
  | CodeIndexArtifactIdentity
  | DerivedArtifactIdentity;

export interface ArtifactManifest {
  readonly version: typeof ARTIFACT_MANIFEST_VERSION;
  readonly key: string;
  readonly identityDigest: Sha256Digest;
  readonly identity: ArtifactIdentity;
  readonly payloadDigest: Sha256Digest;
  readonly files: readonly ArtifactFileEntry[];
  readonly createdAtMs: number;
  readonly expiresAtMs?: number;
}

export interface CacheDiagnostic {
  readonly level: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
}

export type ArtifactInspectionStatus =
  | 'hit'
  | 'miss'
  | 'stale'
  | 'incompatible'
  | 'corrupt'
  | 'bypassed'
  | 'error';

export interface ArtifactInspection {
  readonly status: ArtifactInspectionStatus;
  readonly key: string;
  readonly manifest?: ArtifactManifest;
  readonly diagnostics: readonly CacheDiagnostic[];
  readonly durationMs: number;
}

export interface ArtifactRestoreRequest {
  readonly identity: ArtifactIdentity;
  /** Must not already exist. Restores are atomically promoted to this path. */
  readonly destinationDirectory: string;
}

export interface ArtifactRestoreResult extends ArtifactInspection {
  readonly restoredBytes: number;
}

export interface ArtifactSaveRequest {
  readonly identity: ArtifactIdentity;
  readonly sourceDirectory: string;
  readonly ttlMs?: number;
}

export interface ArtifactSaveResult {
  readonly status: 'saved' | 'already-present' | 'bypassed' | 'failed';
  readonly key: string;
  readonly manifest?: ArtifactManifest;
  readonly savedBytes: number;
  readonly diagnostics: readonly CacheDiagnostic[];
  readonly durationMs: number;
}

export interface ArtifactRemovalResult {
  readonly status: 'removed' | 'missing' | 'bypassed' | 'failed';
  readonly key: string;
  readonly diagnostics: readonly CacheDiagnostic[];
  readonly durationMs: number;
}

export interface ArtifactRetentionPolicy {
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}

export interface ArtifactPruneResult {
  readonly status: 'completed' | 'bypassed' | 'failed';
  readonly removedEntries: number;
  readonly removedBytes: number;
  readonly diagnostics: readonly CacheDiagnostic[];
  readonly durationMs: number;
}

export interface ArtifactCache {
  readonly id: string;
  inspect(identity: ArtifactIdentity): Promise<ArtifactInspection>;
  restore(request: ArtifactRestoreRequest): Promise<ArtifactRestoreResult>;
  save(request: ArtifactSaveRequest): Promise<ArtifactSaveResult>;
  remove(identity: ArtifactIdentity): Promise<ArtifactRemovalResult>;
  prune(policy: ArtifactRetentionPolicy): Promise<ArtifactPruneResult>;
}

export interface ToolInstallRequest {
  readonly descriptor: ReviewToolDescriptor;
  readonly destinationDirectory: string;
  readonly workDirectory: string;
  readonly timeoutMs: number;
}

export interface ToolValidationRequest {
  readonly descriptor: ReviewToolDescriptor;
  readonly installationDirectory: string;
  readonly manifest: InstalledToolManifest;
  readonly timeoutMs: number;
}

export type ToolInstallationResult =
  | {
      readonly status: 'installed';
      readonly manifest: InstalledToolManifest;
      readonly diagnostics: readonly CacheDiagnostic[];
      readonly durationMs: number;
    }
  | {
      readonly status: 'failed' | 'timed-out' | 'unavailable';
      readonly manifest?: never;
      readonly diagnostics: readonly CacheDiagnostic[];
      readonly durationMs: number;
    };

export interface ToolValidationResult {
  readonly status: 'valid' | 'invalid' | 'timed-out' | 'unavailable';
  readonly diagnostics: readonly CacheDiagnostic[];
  readonly durationMs: number;
}

export interface ToolInstaller {
  readonly id: string;
  install(request: ToolInstallRequest): Promise<ToolInstallationResult>;
  validate(request: ToolValidationRequest): Promise<ToolValidationResult>;
}

export type ToolInstallerFactory = () => ToolInstaller;

export interface ToolInstallerRegistration {
  readonly id: string;
  readonly create: ToolInstallerFactory;
}
