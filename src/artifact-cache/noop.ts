import { artifactCacheKey, parseArtifactRetentionPolicy } from './contracts.js';
import type {
  ArtifactCache,
  ArtifactIdentity,
  ArtifactInspection,
  ArtifactPruneResult,
  ArtifactRemovalResult,
  ArtifactRestoreRequest,
  ArtifactRestoreResult,
  ArtifactRetentionPolicy,
  ArtifactSaveRequest,
  ArtifactSaveResult,
  CacheDiagnostic,
} from './types.js';

const BYPASS_DIAGNOSTIC: readonly CacheDiagnostic[] = [{
  level: 'info',
  code: 'cache-bypassed',
  message: 'Artifact caching is disabled.',
}];

/** Explicit no-cache backend; callers still execute required acquisition or analysis work. */
export class NoopArtifactCache implements ArtifactCache {
  readonly id = 'none';

  async inspect(identity: ArtifactIdentity): Promise<ArtifactInspection> {
    return {
      status: 'bypassed',
      key: artifactCacheKey(identity),
      diagnostics: BYPASS_DIAGNOSTIC,
      durationMs: 0,
    };
  }

  async restore(request: ArtifactRestoreRequest): Promise<ArtifactRestoreResult> {
    return {
      ...(await this.inspect(request.identity)),
      restoredBytes: 0,
    };
  }

  async save(request: ArtifactSaveRequest): Promise<ArtifactSaveResult> {
    return {
      status: 'bypassed',
      key: artifactCacheKey(request.identity),
      savedBytes: 0,
      diagnostics: BYPASS_DIAGNOSTIC,
      durationMs: 0,
    };
  }

  async remove(identity: ArtifactIdentity): Promise<ArtifactRemovalResult> {
    return {
      status: 'bypassed',
      key: artifactCacheKey(identity),
      diagnostics: BYPASS_DIAGNOSTIC,
      durationMs: 0,
    };
  }

  async prune(policy: ArtifactRetentionPolicy): Promise<ArtifactPruneResult> {
    parseArtifactRetentionPolicy(policy);
    return {
      status: 'bypassed',
      removedEntries: 0,
      removedBytes: 0,
      diagnostics: BYPASS_DIAGNOSTIC,
      durationMs: 0,
    };
  }
}
