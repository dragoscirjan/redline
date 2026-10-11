import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  parseInstalledToolManifest,
  parseReviewToolDescriptor,
  reviewToolDescriptorDigest,
} from './contracts.js';
import { ToolInstallerRegistry } from './registry.js';
import { installedToolManifestFromCache } from './tool-tree.js';
import {
  ARTIFACT_CACHE_CONTRACT_VERSION,
  type ArtifactCache,
  type CacheDiagnostic,
  type InstalledToolManifest,
  type ReviewToolDescriptor,
  type ToolArtifactIdentity,
  type ToolInstallationResult,
  type ToolValidationResult,
} from './types.js';

const MAX_DIAGNOSTICS = 64;

export interface InstalledToolAcquisitionRequest {
  readonly descriptor: ReviewToolDescriptor;
  /** Must not already exist. */
  readonly installationDirectory: string;
  readonly workDirectory: string;
  readonly timeoutMs: number;
  /** Per-operation cache budget; defaults to one quarter of the acquisition timeout, capped at five seconds. */
  readonly cacheTimeoutMs?: number;
  readonly cacheTtlMs?: number;
}

export type InstalledToolAcquisitionResult =
  | {
      readonly status: 'ready';
      readonly source: 'cache' | 'install';
      readonly manifest: InstalledToolManifest;
      readonly diagnostics: readonly CacheDiagnostic[];
      readonly durationMs: number;
    }
  | {
      readonly status: 'failed' | 'timed-out' | 'unavailable';
      readonly source?: never;
      readonly manifest?: never;
      readonly diagnostics: readonly CacheDiagnostic[];
      readonly durationMs: number;
    };

function cacheIdentity(descriptor: ReviewToolDescriptor): ToolArtifactIdentity {
  return {
    version: ARTIFACT_CACHE_CONTRACT_VERSION,
    kind: 'installed-tool',
    descriptorDigest: reviewToolDescriptorDigest(descriptor),
  };
}

function warningDiagnostics(diagnostics: readonly CacheDiagnostic[]): CacheDiagnostic[] {
  return diagnostics.map((item) => ({ ...item, level: item.level === 'info' ? 'info' : 'warning' }));
}

function boundedDiagnostics(diagnostics: readonly CacheDiagnostic[]): CacheDiagnostic[] {
  return diagnostics.slice(0, MAX_DIAGNOSTICS).map((item) => {
    const bytes = Buffer.from(item.message, 'utf8');
    return bytes.byteLength <= 4_096
      ? item
      : { ...item, message: `${bytes.subarray(0, 4_096).toString('utf8')}…` };
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function removeBestEffort(path: string): Promise<void> {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    // Failed acquisition must still report its original bounded diagnostic.
  }
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, Math.floor(deadline - performance.now()));
}

class CacheOperationTimeout extends Error {}

async function boundedCacheOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onLateSettlement: () => Promise<void> = async () => undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new CacheOperationTimeout('cache operation timed out'));
    }, timeoutMs);
    void operation.then(
      (value) => {
        if (settled) {
          void onLateSettlement();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          void onLateSettlement();
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function canonicalInstalledManifest(
  descriptor: ReviewToolDescriptor,
  manifest: InstalledToolManifest,
): InstalledToolManifest {
  const parsed = parseInstalledToolManifest(manifest);
  if (parsed.descriptorDigest !== reviewToolDescriptorDigest(descriptor)) {
    throw new Error('installer manifest does not match the requested tool descriptor');
  }
  return installedToolManifestFromCache(descriptor, parsed.files);
}

/** Restores or installs one exact tool without making cache availability a correctness requirement. */
export class InstalledToolManager {
  constructor(
    readonly cache: ArtifactCache,
    readonly installers: ToolInstallerRegistry,
  ) {}

  async acquire(request: InstalledToolAcquisitionRequest): Promise<InstalledToolAcquisitionResult> {
    const startedAt = performance.now();
    const descriptor = parseReviewToolDescriptor(request.descriptor);
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error('tool acquisition timeout must be a positive safe integer');
    }
    if (
      request.cacheTtlMs !== undefined
      && (!Number.isSafeInteger(request.cacheTtlMs) || request.cacheTtlMs <= 0)
    ) throw new Error('tool cache TTL must be a positive safe integer');
    if (
      request.cacheTimeoutMs !== undefined
      && (!Number.isSafeInteger(request.cacheTimeoutMs) || request.cacheTimeoutMs <= 0)
    ) throw new Error('tool cache timeout must be a positive safe integer');
    if (await pathExists(request.installationDirectory)) {
      throw new Error('tool installation destination already exists');
    }

    const deadline = performance.now() + request.timeoutMs;
    const cacheTimeoutMs = request.cacheTimeoutMs
      ?? Math.min(5_000, Math.max(100, Math.floor(request.timeoutMs / 4)));
    const identity = cacheIdentity(descriptor);
    const installer = this.installers.create(descriptor.id);
    const diagnostics: CacheDiagnostic[] = [];
    let cachePublicationSafe = true;
    const restoreDirectory = join(
      dirname(request.installationDirectory),
      `.${basename(request.installationDirectory)}.cache-${randomUUID()}`,
    );
    await mkdir(dirname(request.installationDirectory), { recursive: true });
    let restored;
    try {
      restored = await boundedCacheOperation(
        this.cache.restore({ identity, destinationDirectory: restoreDirectory }),
        Math.min(cacheTimeoutMs, remainingTimeout(deadline)),
        () => removeBestEffort(restoreDirectory),
      );
      diagnostics.push(...warningDiagnostics(restored.diagnostics));
      if (restored.status === 'hit') await rename(restoreDirectory, request.installationDirectory);
      else await removeBestEffort(restoreDirectory);
    } catch (error) {
      restored = undefined;
      const timedOut = error instanceof CacheOperationTimeout;
      if (timedOut) cachePublicationSafe = false;
      else await removeBestEffort(restoreDirectory);
      diagnostics.push({
        level: 'warning',
        code: timedOut ? 'tool-cache-restore-timed-out' : 'tool-cache-restore-error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (restored?.status === 'hit' && restored.manifest !== undefined) {
      try {
        const manifest = installedToolManifestFromCache(descriptor, restored.manifest.files);
        const validation = await installer.validate({
          descriptor,
          installationDirectory: request.installationDirectory,
          manifest,
          timeoutMs: remainingTimeout(deadline),
        });
        diagnostics.push(...validation.diagnostics);
        if (validation.status === 'valid') {
          return {
            status: 'ready',
            source: 'cache',
            manifest,
            diagnostics: boundedDiagnostics(diagnostics),
            durationMs: performance.now() - startedAt,
          };
        }
        diagnostics.push({
          level: 'warning',
          code: 'cached-tool-rejected',
          message: `cached tool failed validation with status ${validation.status}; reinstalling`,
        });
      } catch (error) {
        diagnostics.push({
          level: 'warning',
          code: 'cached-tool-manifest-invalid',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await removeBestEffort(request.installationDirectory);
      try {
        const removal = await boundedCacheOperation(
          this.cache.remove(identity),
          Math.min(cacheTimeoutMs, remainingTimeout(deadline)),
        );
        diagnostics.push(...warningDiagnostics(removal.diagnostics));
        if (removal.status === 'failed') cachePublicationSafe = false;
      } catch (error) {
        cachePublicationSafe = false;
        diagnostics.push({
          level: 'warning',
          code: error instanceof CacheOperationTimeout
            ? 'tool-cache-remove-timed-out'
            : 'tool-cache-remove-error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      await removeBestEffort(request.installationDirectory);
    }

    let installed: ToolInstallationResult;
    try {
      installed = await installer.install({
        descriptor,
        destinationDirectory: request.installationDirectory,
        workDirectory: request.workDirectory,
        timeoutMs: remainingTimeout(deadline),
      });
    } catch (error) {
      await removeBestEffort(request.installationDirectory);
      return {
        status: 'failed',
        diagnostics: boundedDiagnostics([...diagnostics, {
          level: 'error',
          code: 'tool-installer-error',
          message: error instanceof Error ? error.message : String(error),
        }]),
        durationMs: performance.now() - startedAt,
      };
    }
    diagnostics.push(...installed.diagnostics);
    if (installed.status !== 'installed') {
      await removeBestEffort(request.installationDirectory);
      return {
        status: installed.status,
        diagnostics: boundedDiagnostics(diagnostics),
        durationMs: performance.now() - startedAt,
      };
    }

    let manifest: InstalledToolManifest;
    try {
      manifest = canonicalInstalledManifest(descriptor, installed.manifest);
    } catch (error) {
      await removeBestEffort(request.installationDirectory);
      diagnostics.push({
        level: 'error',
        code: 'installed-tool-manifest-invalid',
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'failed',
        diagnostics: boundedDiagnostics(diagnostics),
        durationMs: performance.now() - startedAt,
      };
    }

    let validation: ToolValidationResult;
    try {
      validation = await installer.validate({
        descriptor,
        installationDirectory: request.installationDirectory,
        manifest,
        timeoutMs: remainingTimeout(deadline),
      });
    } catch (error) {
      await removeBestEffort(request.installationDirectory);
      return {
        status: 'failed',
        diagnostics: boundedDiagnostics([...diagnostics, {
          level: 'error',
          code: 'tool-validation-error',
          message: error instanceof Error ? error.message : String(error),
        }]),
        durationMs: performance.now() - startedAt,
      };
    }
    diagnostics.push(...validation.diagnostics);
    if (validation.status !== 'valid') {
      await removeBestEffort(request.installationDirectory);
      return {
        status: validation.status === 'invalid' ? 'failed' : validation.status,
        diagnostics: boundedDiagnostics(diagnostics),
        durationMs: performance.now() - startedAt,
      };
    }

    if (!cachePublicationSafe) {
      diagnostics.push({
        level: 'warning',
        code: 'tool-cache-publication-skipped',
        message: 'cache publication was skipped because an earlier cache operation did not settle safely',
      });
    } else {
      try {
        const saved = await boundedCacheOperation(
          this.cache.save({
            identity,
            sourceDirectory: request.installationDirectory,
            ...(request.cacheTtlMs === undefined ? {} : { ttlMs: request.cacheTtlMs }),
          }),
          Math.min(cacheTimeoutMs, remainingTimeout(deadline)),
        );
        diagnostics.push(...warningDiagnostics(saved.diagnostics));
        if (saved.manifest !== undefined && saved.manifest.payloadDigest !== manifest.payloadDigest) {
          diagnostics.push({
            level: 'warning',
            code: 'installed-tool-cache-conflict',
            message: 'an existing cache entry has a different payload; the conflicting cache entry was evicted',
          });
          try {
            const removal = await boundedCacheOperation(
              this.cache.remove(identity),
              Math.min(cacheTimeoutMs, remainingTimeout(deadline)),
            );
            diagnostics.push(...warningDiagnostics(removal.diagnostics));
          } catch (error) {
            diagnostics.push({
              level: 'warning',
              code: error instanceof CacheOperationTimeout
                ? 'tool-cache-remove-timed-out'
                : 'tool-cache-remove-error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        diagnostics.push({
          level: 'warning',
          code: error instanceof CacheOperationTimeout ? 'tool-cache-save-timed-out' : 'tool-cache-save-error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      status: 'ready',
      source: 'install',
      manifest,
      diagnostics: boundedDiagnostics(diagnostics),
      durationMs: performance.now() - startedAt,
    };
  }
}
