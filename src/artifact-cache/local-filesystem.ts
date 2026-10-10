import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  artifactCacheKey,
  artifactIdentityDigest,
  artifactPayloadDigest,
  parseArtifactFileEntries,
  parseArtifactIdentity,
  parseArtifactManifest,
  parseArtifactRetentionPolicy,
} from './contracts.js';
import {
  ARTIFACT_MANIFEST_VERSION,
  type ArtifactCache,
  type ArtifactFileEntry,
  type ArtifactIdentity,
  type ArtifactInspection,
  type ArtifactInspectionStatus,
  type ArtifactManifest,
  type ArtifactPruneResult,
  type ArtifactRemovalResult,
  type ArtifactRestoreRequest,
  type ArtifactRestoreResult,
  type ArtifactRetentionPolicy,
  type ArtifactSaveRequest,
  type ArtifactSaveResult,
  type CacheDiagnostic,
  type Sha256Digest,
} from './types.js';

const MANIFEST_NAME = 'manifest.json';
const PAYLOAD_DIRECTORY = 'payload';
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4_096;
const MAX_PRUNE_DIAGNOSTICS = 64;

let lockSequence = 0;
let staleLockSequence = 0;
const activeLockTokens = new Set<string>();

export interface LocalFilesystemArtifactCacheOptions {
  readonly now?: () => number;
  readonly sleep?: (durationMs: number) => Promise<void>;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
  readonly staleLockMs?: number;
  readonly maxManifestBytes?: number;
}

interface ValidatedArtifact {
  readonly status: 'hit';
  readonly key: string;
  readonly directory: string;
  readonly manifest: ArtifactManifest;
  readonly bytes: number;
  readonly diagnostics: readonly CacheDiagnostic[];
}

interface UnavailableArtifact {
  readonly status: Exclude<ArtifactInspectionStatus, 'hit'>;
  readonly key: string;
  readonly directory: string;
  readonly manifest?: ArtifactManifest;
  readonly diagnostics: readonly CacheDiagnostic[];
}

type InternalInspection = ValidatedArtifact | UnavailableArtifact;

interface RetentionCandidate {
  readonly key: string;
  readonly directory: string;
  readonly payloadDigest: Sha256Digest;
  readonly createdAtMs: number;
  readonly expiresAtMs?: number;
  readonly bytes: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (Buffer.byteLength(raw, 'utf8') <= MAX_DIAGNOSTIC_BYTES) return raw;
  return `${Buffer.from(raw, 'utf8').subarray(0, MAX_DIAGNOSTIC_BYTES).toString('utf8')}…`;
}

function diagnostic(level: CacheDiagnostic['level'], code: string, message: string): CacheDiagnostic {
  return { level, code, message };
}

function totalBytes(files: readonly ArtifactFileEntry[]): number {
  return files.reduce((total, file) => total + file.bytes, 0);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function removeBestEffort(path: string): Promise<void> {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    // Temporary cleanup failure must not escape the result-based cache API.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

async function hashFile(path: string): Promise<Sha256Digest> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest('hex')}`;
}

async function scanDirectory(root: string, relativeDirectory = ''): Promise<ArtifactFileEntry[]> {
  const absoluteDirectory = relativeDirectory.length === 0 ? root : join(root, ...relativeDirectory.split('/'));
  const directoryMetadata = await lstat(absoluteDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`artifact directory changed type while scanning: ${relativeDirectory || '.'}`);
  }
  if ((directoryMetadata.mode & 0o777) !== 0o755) {
    throw new Error(`artifact directories must use mode 0755: ${relativeDirectory || '.'}`);
  }
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  if (entries.length === 0 && relativeDirectory.length > 0) {
    throw new Error(`artifact trees must not contain empty directories: ${relativeDirectory}`);
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  const files: ArtifactFileEntry[] = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    const absolutePath = join(root, ...relativePath.split('/'));
    if (entry.isSymbolicLink()) throw new Error(`artifact trees must not contain symbolic links: ${relativePath}`);
    if (entry.isDirectory()) {
      files.push(...await scanDirectory(root, relativePath));
      continue;
    }
    if (!entry.isFile()) throw new Error(`artifact trees may contain only regular files and directories: ${relativePath}`);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) throw new Error(`artifact file changed type while scanning: ${relativePath}`);
    files.push({
      path: relativePath,
      digest: await hashFile(absolutePath),
      bytes: metadata.size,
      mode: metadata.mode & 0o777,
    });
  }
  files.sort((left, right) => compareText(left.path, right.path));
  return parseArtifactFileEntries(files);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if ((metadata.mode & 0o777) !== 0o755) throw new Error(`${label} must use directory mode 0755`);
}

async function copyFiles(
  sourceRoot: string,
  destinationRoot: string,
  files: readonly ArtifactFileEntry[],
): Promise<void> {
  for (const file of files) {
    const source = join(sourceRoot, ...file.path.split('/'));
    const destination = join(destinationRoot, ...file.path.split('/'));
    const sourceMetadata = await lstat(source);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      throw new Error(`artifact source changed type before copy: ${file.path}`);
    }
    let destinationDirectory = destinationRoot;
    for (const segment of file.path.split('/').slice(0, -1)) {
      destinationDirectory = join(destinationDirectory, segment);
      await mkdir(destinationDirectory, { recursive: true });
      await chmod(destinationDirectory, 0o755);
    }
    await copyFile(source, destination);
    await chmod(destination, file.mode);
  }
}

function manifestsMatch(left: readonly ArtifactFileEntry[], right: readonly ArtifactFileEntry[]): boolean {
  return artifactPayloadDigest(left) === artifactPayloadDigest(right);
}

/**
 * Immutable local cache for trusted host-produced directories.
 *
 * Payload trees reject symbolic links. Pull-request content must never select
 * the cache root, identity, source directory, or restore destination.
 */
export class LocalFilesystemArtifactCache implements ArtifactCache {
  readonly id = 'local-filesystem';
  readonly #rootDirectory: string;
  readonly #now: () => number;
  readonly #sleep: (durationMs: number) => Promise<void>;
  readonly #lockTimeoutMs: number;
  readonly #lockRetryMs: number;
  readonly #staleLockMs: number;
  readonly #maxManifestBytes: number;

  constructor(rootDirectory: string, options: LocalFilesystemArtifactCacheOptions = {}) {
    if (rootDirectory.length === 0) throw new Error('cache root directory must not be empty');
    this.#rootDirectory = rootDirectory;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.#lockRetryMs = options.lockRetryMs ?? 25;
    this.#staleLockMs = options.staleLockMs ?? 60_000;
    this.#maxManifestBytes = options.maxManifestBytes ?? MAX_MANIFEST_BYTES;
    if ([
      this.#lockTimeoutMs,
      this.#lockRetryMs,
      this.#staleLockMs,
      this.#maxManifestBytes,
    ].some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('cache timing and manifest bounds must be positive safe integers');
    }
  }

  #artifactDirectory(key: string): string {
    return join(this.#rootDirectory, 'artifacts', ...key.split('/'));
  }

  #lockPath(key: string): string {
    const parts = key.split('/');
    return join(this.#rootDirectory, 'locks', `${parts[1]}-${parts[2]}.lock`);
  }

  async #acquireLock(key: string): Promise<() => Promise<void>> {
    const locksDirectory = join(this.#rootDirectory, 'locks');
    await mkdir(locksDirectory, { recursive: true });
    const lockPath = this.#lockPath(key);
    const ownerPath = join(lockPath, 'owner.json');
    const startedAt = performance.now();
    while (true) {
      try {
        await mkdir(lockPath);
        lockSequence += 1;
        const token = `${process.pid}-${Date.now()}-${lockSequence}`;
        try {
          await writeFile(ownerPath, `${JSON.stringify({ token, pid: process.pid })}\n`, { mode: 0o600 });
          activeLockTokens.add(token);
        } catch (ownerError) {
          await removeBestEffort(lockPath);
          throw ownerError;
        }
        const heartbeatMs = Math.max(1, Math.floor(this.#staleLockMs / 3));
        const heartbeat = setInterval(() => {
          const now = new Date();
          void utimes(ownerPath, now, now).catch(() => undefined);
        }, heartbeatMs);
        heartbeat.unref();
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          activeLockTokens.delete(token);
          try {
            const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown };
            if (owner.token === token) await rm(lockPath, { force: true, recursive: true });
          } catch {
            // A missing or replaced lease is no longer owned by this caller.
          }
        };
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        try {
          let activity = await stat(lockPath);
          let ownerPid: number | undefined;
          let ownerToken: string | undefined;
          try {
            const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid?: unknown; token?: unknown };
            if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) ownerPid = owner.pid as number;
            if (typeof owner.token === 'string') ownerToken = owner.token;
            activity = await stat(ownerPath);
          } catch (ownerError) {
            if (!isErrno(ownerError, 'ENOENT') && !(ownerError instanceof SyntaxError)) throw ownerError;
          }
          const ownerAlive = ownerPid === process.pid && ownerToken !== undefined
            ? activeLockTokens.has(ownerToken)
            : ownerPid !== undefined && processIsAlive(ownerPid);
          const reclaimAfterMs = ownerPid === undefined ? Math.max(this.#staleLockMs, 1_000) : this.#staleLockMs;
          if (!ownerAlive && Date.now() - activity.mtimeMs >= reclaimAfterMs) {
            staleLockSequence += 1;
            const stalePath = `${lockPath}.stale.${process.pid}.${staleLockSequence}`;
            try {
              await rename(lockPath, stalePath);
              await removeBestEffort(stalePath);
              continue;
            } catch (renameError) {
              if (!isErrno(renameError, 'ENOENT')) throw renameError;
            }
          }
        } catch (statError) {
          if (isErrno(statError, 'ENOENT')) continue;
          throw statError;
        }
        if (performance.now() - startedAt >= this.#lockTimeoutMs) {
          throw new Error(`timed out waiting for cache publication lock: ${key}`);
        }
        await this.#sleep(this.#lockRetryMs);
      }
    }
  }

  async #readManifest(directory: string): Promise<ArtifactManifest> {
    const path = join(directory, MANIFEST_NAME);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > this.#maxManifestBytes) {
      throw new Error('cache manifest is missing, non-regular, or oversized');
    }
    const raw = await readFile(path, 'utf8');
    return parseArtifactManifest(JSON.parse(raw));
  }

  async #validatePayload(directory: string, manifest: ArtifactManifest): Promise<number> {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort(compareText);
    if (
      names.length !== 2 ||
      names[0] !== MANIFEST_NAME ||
      names[1] !== PAYLOAD_DIRECTORY ||
      !entries.find((entry) => entry.name === MANIFEST_NAME)?.isFile() ||
      !entries.find((entry) => entry.name === PAYLOAD_DIRECTORY)?.isDirectory()
    ) throw new Error('cache artifact contains unexpected top-level entries');
    const actual = await scanDirectory(join(directory, PAYLOAD_DIRECTORY));
    if (!manifestsMatch(actual, manifest.files)) throw new Error('cache payload does not match its manifest');
    return totalBytes(actual);
  }

  async #inspectInternal(identity: ArtifactIdentity): Promise<InternalInspection> {
    const normalizedIdentity = parseArtifactIdentity(identity);
    const key = artifactCacheKey(normalizedIdentity);
    const directory = this.#artifactDirectory(key);
    let manifest: ArtifactManifest;
    try {
      manifest = await this.#readManifest(directory);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { status: 'miss', key, directory, diagnostics: [] };
      }
      if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) {
        return {
          status: 'error',
          key,
          directory,
          diagnostics: [diagnostic('error', 'cache-read-failed', errorMessage(error))],
        };
      }
      return {
        status: 'corrupt',
        key,
        directory,
        diagnostics: [diagnostic('warning', 'cache-manifest-corrupt', errorMessage(error))],
      };
    }
    if (manifest.key !== key || manifest.identityDigest !== artifactIdentityDigest(normalizedIdentity)) {
      return {
        status: 'incompatible',
        key,
        directory,
        manifest,
        diagnostics: [diagnostic('warning', 'cache-identity-mismatch', 'Cached metadata does not match the requested identity.')],
      };
    }
    if (manifest.expiresAtMs !== undefined && manifest.expiresAtMs <= this.#now()) {
      return {
        status: 'stale',
        key,
        directory,
        manifest,
        diagnostics: [diagnostic('info', 'cache-expired', 'Cached artifact has expired.')],
      };
    }
    try {
      const bytes = await this.#validatePayload(directory, manifest);
      return { status: 'hit', key, directory, manifest, bytes, diagnostics: [] };
    } catch (error) {
      if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) {
        return {
          status: 'error',
          key,
          directory,
          manifest,
          diagnostics: [diagnostic('error', 'cache-validation-failed', errorMessage(error))],
        };
      }
      return {
        status: 'corrupt',
        key,
        directory,
        manifest,
        diagnostics: [diagnostic('warning', 'cache-payload-corrupt', errorMessage(error))],
      };
    }
  }

  async inspect(identity: ArtifactIdentity): Promise<ArtifactInspection> {
    const startedAt = performance.now();
    const inspected = await this.#inspectInternal(identity);
    return {
      status: inspected.status,
      key: inspected.key,
      ...('manifest' in inspected && inspected.manifest !== undefined ? { manifest: inspected.manifest } : {}),
      diagnostics: inspected.diagnostics,
      durationMs: performance.now() - startedAt,
    };
  }

  async restore(request: ArtifactRestoreRequest): Promise<ArtifactRestoreResult> {
    const startedAt = performance.now();
    const inspected = await this.#inspectInternal(request.identity);
    if (inspected.status !== 'hit') {
      if (['stale', 'incompatible', 'corrupt'].includes(inspected.status)) await this.remove(request.identity);
      return {
        status: inspected.status,
        key: inspected.key,
        ...('manifest' in inspected && inspected.manifest !== undefined ? { manifest: inspected.manifest } : {}),
        restoredBytes: 0,
        diagnostics: inspected.diagnostics,
        durationMs: performance.now() - startedAt,
      };
    }
    let temporaryDirectory: string | undefined;
    try {
      if (await pathExists(request.destinationDirectory)) {
        throw new Error('restore destination already exists');
      }
      const parent = dirname(request.destinationDirectory);
      await mkdir(parent, { recursive: true });
      temporaryDirectory = await mkdtemp(join(parent, `.${basename(request.destinationDirectory)}.restore-`));
      await chmod(temporaryDirectory, 0o755);
      await copyFiles(join(inspected.directory, PAYLOAD_DIRECTORY), temporaryDirectory, inspected.manifest.files);
      const restoredFiles = await scanDirectory(temporaryDirectory);
      if (!manifestsMatch(restoredFiles, inspected.manifest.files)) {
        throw new Error('restored payload failed post-copy validation');
      }
      await rename(temporaryDirectory, request.destinationDirectory);
      temporaryDirectory = undefined;
      return {
        status: 'hit',
        key: inspected.key,
        manifest: inspected.manifest,
        restoredBytes: inspected.bytes,
        diagnostics: [],
        durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      return {
        status: 'error',
        key: inspected.key,
        manifest: inspected.manifest,
        restoredBytes: 0,
        diagnostics: [diagnostic('error', 'cache-restore-failed', errorMessage(error))],
        durationMs: performance.now() - startedAt,
      };
    } finally {
      if (temporaryDirectory !== undefined) await removeBestEffort(temporaryDirectory);
    }
  }

  async save(request: ArtifactSaveRequest): Promise<ArtifactSaveResult> {
    const startedAt = performance.now();
    const identity = parseArtifactIdentity(request.identity);
    const key = artifactCacheKey(identity);
    if (request.ttlMs !== undefined && (!Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0)) {
      throw new Error('artifact ttlMs must be a positive safe integer');
    }
    let releaseLock: (() => Promise<void>) | undefined;
    let temporaryDirectory: string | undefined;
    try {
      await assertDirectory(request.sourceDirectory, 'artifact sourceDirectory');
      releaseLock = await this.#acquireLock(key);
      const existing = await this.#inspectInternal(identity);
      if (existing.status === 'hit') {
        return {
          status: 'already-present',
          key,
          manifest: existing.manifest,
          savedBytes: 0,
          diagnostics: [],
          durationMs: performance.now() - startedAt,
        };
      }
      if (existing.status === 'error') {
        return {
          status: 'failed',
          key,
          savedBytes: 0,
          diagnostics: existing.diagnostics,
          durationMs: performance.now() - startedAt,
        };
      }
      await rm(existing.directory, { force: true, recursive: true });
      const parent = dirname(existing.directory);
      await mkdir(parent, { recursive: true });
      temporaryDirectory = await mkdtemp(join(parent, `.publish-${basename(existing.directory)}-`));
      const payloadDirectory = join(temporaryDirectory, PAYLOAD_DIRECTORY);
      await mkdir(payloadDirectory);
      await chmod(payloadDirectory, 0o755);
      const sourceFiles = await scanDirectory(request.sourceDirectory);
      await copyFiles(request.sourceDirectory, payloadDirectory, sourceFiles);
      const copiedFiles = await scanDirectory(payloadDirectory);
      if (!manifestsMatch(sourceFiles, copiedFiles)) throw new Error('artifact source changed while being cached');
      const createdAtMs = this.#now();
      const manifest = parseArtifactManifest({
        version: ARTIFACT_MANIFEST_VERSION,
        key,
        identityDigest: artifactIdentityDigest(identity),
        identity,
        payloadDigest: artifactPayloadDigest(copiedFiles),
        files: copiedFiles,
        createdAtMs,
        ...(request.ttlMs === undefined ? {} : { expiresAtMs: createdAtMs + request.ttlMs }),
      });
      const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
      if (Buffer.byteLength(serializedManifest, 'utf8') > this.#maxManifestBytes) {
        throw new Error(`cache manifest exceeds ${this.#maxManifestBytes} bytes`);
      }
      await writeFile(join(temporaryDirectory, MANIFEST_NAME), serializedManifest, { mode: 0o600 });
      await rename(temporaryDirectory, existing.directory);
      temporaryDirectory = undefined;
      return {
        status: 'saved',
        key,
        manifest,
        savedBytes: totalBytes(copiedFiles),
        diagnostics: [],
        durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      return {
        status: 'failed',
        key,
        savedBytes: 0,
        diagnostics: [diagnostic('error', 'cache-save-failed', errorMessage(error))],
        durationMs: performance.now() - startedAt,
      };
    } finally {
      if (temporaryDirectory !== undefined) await removeBestEffort(temporaryDirectory);
      if (releaseLock !== undefined) await releaseLock();
    }
  }

  async remove(identity: ArtifactIdentity): Promise<ArtifactRemovalResult> {
    const startedAt = performance.now();
    const normalizedIdentity = parseArtifactIdentity(identity);
    const key = artifactCacheKey(normalizedIdentity);
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      releaseLock = await this.#acquireLock(key);
      const directory = this.#artifactDirectory(key);
      if (!await pathExists(directory)) {
        return { status: 'missing', key, diagnostics: [], durationMs: performance.now() - startedAt };
      }
      await rm(directory, { force: true, recursive: true });
      return { status: 'removed', key, diagnostics: [], durationMs: performance.now() - startedAt };
    } catch (error) {
      return {
        status: 'failed',
        key,
        diagnostics: [diagnostic('error', 'cache-remove-failed', errorMessage(error))],
        durationMs: performance.now() - startedAt,
      };
    } finally {
      if (releaseLock !== undefined) await releaseLock();
    }
  }

  async #lockAppearsActive(key: string): Promise<boolean> {
    const lockPath = this.#lockPath(key);
    try {
      let activity = await stat(lockPath);
      let ownerPid: number | undefined;
      let ownerToken: string | undefined;
      try {
        const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
          pid?: unknown;
          token?: unknown;
        };
        if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) ownerPid = owner.pid as number;
        if (typeof owner.token === 'string') ownerToken = owner.token;
        activity = await stat(join(lockPath, 'owner.json'));
      } catch (error) {
        if (!isErrno(error, 'ENOENT') && !(error instanceof SyntaxError)) return true;
      }
      const ownerAlive = ownerPid === process.pid && ownerToken !== undefined
        ? activeLockTokens.has(ownerToken)
        : ownerPid !== undefined && processIsAlive(ownerPid);
      const staleAfterMs = ownerPid === undefined ? Math.max(this.#staleLockMs, 1_000) : this.#staleLockMs;
      return ownerAlive || Date.now() - activity.mtimeMs < staleAfterMs;
    } catch (error) {
      return !isErrno(error, 'ENOENT');
    }
  }

  async #cleanupOrphans(): Promise<number> {
    const now = Date.now();
    const locksDirectory = join(this.#rootDirectory, 'locks');
    try {
      const locks = await readdir(locksDirectory, { withFileTypes: true });
      for (const lock of locks) {
        if (!lock.isDirectory() || lock.isSymbolicLink() || !lock.name.includes('.lock.stale.')) continue;
        const path = join(locksDirectory, lock.name);
        const metadata = await lstat(path);
        if (now - metadata.mtimeMs >= this.#staleLockMs) await removeBestEffort(path);
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }

    const versionDirectory = join(this.#rootDirectory, 'artifacts', 'v1');
    let kinds;
    try {
      kinds = await readdir(versionDirectory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return 0;
      throw error;
    }
    let removed = 0;
    for (const kind of kinds) {
      if (!kind.isDirectory() || kind.isSymbolicLink()) continue;
      const kindDirectory = join(versionDirectory, kind.name);
      const artifacts = await readdir(kindDirectory, { withFileTypes: true });
      for (const artifact of artifacts) {
        const match = /^\.publish-([0-9a-f]{64})-/u.exec(artifact.name);
        if (!artifact.isDirectory() || artifact.isSymbolicLink() || match === null) continue;
        const path = join(kindDirectory, artifact.name);
        const metadata = await lstat(path);
        if (now - metadata.mtimeMs < this.#staleLockMs) continue;
        const key = `v1/${kind.name}/${match[1]}`;
        if (await this.#lockAppearsActive(key)) continue;
        let releaseLock: (() => Promise<void>) | undefined;
        try {
          releaseLock = await this.#acquireLock(key);
          const current = await lstat(path);
          if (now - current.mtimeMs < this.#staleLockMs) continue;
          await rm(path, { force: true, recursive: true });
          removed += 1;
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        } finally {
          if (releaseLock !== undefined) await releaseLock();
        }
      }
    }
    return removed;
  }

  async #artifactDirectories(): Promise<string[]> {
    const versionDirectory = join(this.#rootDirectory, 'artifacts', 'v1');
    let kinds;
    try {
      kinds = await readdir(versionDirectory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }
    kinds.sort((left, right) => compareText(left.name, right.name));
    const directories: string[] = [];
    for (const kind of kinds) {
      if (!kind.isDirectory() || kind.isSymbolicLink()) continue;
      const kindDirectory = join(versionDirectory, kind.name);
      const artifacts = await readdir(kindDirectory, { withFileTypes: true });
      artifacts.sort((left, right) => compareText(left.name, right.name));
      for (const artifact of artifacts) {
        if (artifact.isDirectory() && !artifact.isSymbolicLink() && /^[0-9a-f]{64}$/u.test(artifact.name)) {
          directories.push(join(kindDirectory, artifact.name));
        }
      }
    }
    return directories;
  }

  async prune(policy: ArtifactRetentionPolicy): Promise<ArtifactPruneResult> {
    const startedAt = performance.now();
    const normalizedPolicy = parseArtifactRetentionPolicy(policy);
    const diagnostics: CacheDiagnostic[] = [];
    let removedEntries = 0;
    let removedBytes = 0;
    try {
      removedEntries += await this.#cleanupOrphans();
      const candidates: RetentionCandidate[] = [];
      for (const directory of await this.#artifactDirectories()) {
        try {
          const manifest = await this.#readManifest(directory);
          if (this.#artifactDirectory(manifest.key) !== directory) {
            throw new Error('cache manifest is stored under the wrong key path');
          }
          const bytes = await this.#validatePayload(directory, manifest);
          candidates.push({
            key: manifest.key,
            directory,
            payloadDigest: manifest.payloadDigest,
            createdAtMs: manifest.createdAtMs,
            ...(manifest.expiresAtMs === undefined ? {} : { expiresAtMs: manifest.expiresAtMs }),
            bytes,
          });
        } catch (error) {
          const digest = basename(directory);
          const kind = basename(dirname(directory));
          const key = `v1/${kind}/${digest}`;
          const releaseLock = await this.#acquireLock(key);
          let remainsCorrupt = false;
          try {
            try {
              const current = await this.#readManifest(directory);
              if (this.#artifactDirectory(current.key) !== directory) throw new Error('cache key path mismatch');
              await this.#validatePayload(directory, current);
            } catch {
              remainsCorrupt = true;
              await rm(directory, { force: true, recursive: true });
            }
          } finally {
            await releaseLock();
          }
          if (remainsCorrupt) {
            removedEntries += 1;
            if (diagnostics.length < MAX_PRUNE_DIAGNOSTICS) {
              diagnostics.push(diagnostic('warning', 'cache-pruned-corrupt', errorMessage(error)));
            }
          }
        }
      }
      const now = this.#now();
      const ordered = candidates.sort((left, right) =>
        left.createdAtMs - right.createdAtMs || compareText(left.key, right.key));
      const removals = new Set<string>();
      for (const candidate of ordered) {
        if (
          (candidate.expiresAtMs !== undefined && candidate.expiresAtMs <= now) ||
          (normalizedPolicy.maxAgeMs !== undefined && now - candidate.createdAtMs >= normalizedPolicy.maxAgeMs)
        ) removals.add(candidate.key);
      }
      let retained = ordered.filter((candidate) => !removals.has(candidate.key));
      if (normalizedPolicy.maxEntries !== undefined) {
        while (retained.length > normalizedPolicy.maxEntries) {
          const candidate = retained.shift();
          if (candidate !== undefined) removals.add(candidate.key);
        }
      }
      if (normalizedPolicy.maxBytes !== undefined) {
        let retainedBytes = retained.reduce((total, candidate) => total + candidate.bytes, 0);
        while (retainedBytes > normalizedPolicy.maxBytes) {
          const candidate = retained.shift();
          if (candidate === undefined) break;
          removals.add(candidate.key);
          retainedBytes -= candidate.bytes;
        }
      }
      for (const candidate of ordered) {
        if (!removals.has(candidate.key)) continue;
        let releaseLock: (() => Promise<void>) | undefined;
        try {
          releaseLock = await this.#acquireLock(candidate.key);
          let current: ArtifactManifest;
          try {
            current = await this.#readManifest(candidate.directory);
          } catch {
            await rm(candidate.directory, { force: true, recursive: true });
            removedEntries += 1;
            removedBytes += candidate.bytes;
            continue;
          }
          if (
            current.key !== candidate.key ||
            current.createdAtMs !== candidate.createdAtMs ||
            current.payloadDigest !== candidate.payloadDigest
          ) continue;
          await rm(candidate.directory, { force: true, recursive: true });
          removedEntries += 1;
          removedBytes += candidate.bytes;
        } finally {
          if (releaseLock !== undefined) await releaseLock();
        }
      }
      return {
        status: 'completed',
        removedEntries,
        removedBytes,
        diagnostics,
        durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      return {
        status: 'failed',
        removedEntries,
        removedBytes,
        diagnostics: [...diagnostics, diagnostic('error', 'cache-prune-failed', errorMessage(error))]
          .slice(0, MAX_PRUNE_DIAGNOSTICS),
        durationMs: performance.now() - startedAt,
      };
    }
  }
}
