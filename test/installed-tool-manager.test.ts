import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_CACHE_CONTRACT_VERSION,
  REVIEW_TOOL_DESCRIPTOR_VERSION,
  type ArtifactCache,
  type ArtifactIdentity,
  type ArtifactRetentionPolicy,
  type ArtifactRestoreRequest,
  type ArtifactSaveRequest,
  type ReviewToolDescriptor,
  type ToolInstallationResult,
  type ToolInstaller,
  type ToolInstallRequest,
  type ToolValidationRequest,
  type ToolValidationResult,
} from '../src/artifact-cache/types.js';
import { artifactCacheKey, reviewToolDescriptorDigest } from '../src/artifact-cache/contracts.js';
import { InstalledToolManager } from '../src/artifact-cache/installed-tool-manager.js';
import { LocalFilesystemArtifactCache } from '../src/artifact-cache/local-filesystem.js';
import { NoopArtifactCache } from '../src/artifact-cache/noop.js';
import { ToolInstallerRegistry } from '../src/artifact-cache/registry.js';
import { createInstalledToolManifest } from '../src/artifact-cache/tool-tree.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function descriptor(): ReviewToolDescriptor {
  return {
    version: REVIEW_TOOL_DESCRIPTOR_VERSION,
    id: 'fixture-indexer',
    displayName: 'Fixture Indexer',
    family: 'code-indexer',
    providerId: 'fixture-indexer',
    toolVersion: '1.0.0',
    distribution: {
      source: 'https://example.invalid/fixture-indexer-1.0.0',
      digest: `sha256:${'1'.repeat(64)}`,
    },
    license: {
      name: 'MIT License',
      spdx: 'MIT',
      url: 'https://example.invalid/license',
      redistribution: 'allowed',
    },
    installerRecipeVersion: 'fixture-v1',
    platform: { operatingSystem: process.platform, architecture: process.arch },
    runtimes: [],
    grammars: [],
    features: [],
    healthProbe: {
      executable: 'bin/fixture',
      args: ['--version'],
      expectedExitCode: 0,
      expectedOutput: '1.0.0',
    },
  };
}

async function writeTool(directory: string, content: string): Promise<void> {
  await mkdir(join(directory, 'bin'), { recursive: true });
  await chmod(directory, 0o755);
  await chmod(join(directory, 'bin'), 0o755);
  await writeFile(join(directory, 'bin', 'fixture'), content);
  await chmod(join(directory, 'bin', 'fixture'), 0o755);
}

class FailingCache implements ArtifactCache {
  readonly id = 'failing';
  readonly #fallback = new NoopArtifactCache();

  inspect(identity: ArtifactIdentity) {
    return this.#fallback.inspect(identity);
  }

  async restore(request: ArtifactRestoreRequest) {
    return {
      status: 'error' as const,
      key: artifactCacheKey(request.identity),
      restoredBytes: 0,
      diagnostics: [{ level: 'error' as const, code: 'restore-failed', message: 'offline' }],
      durationMs: 0,
    };
  }

  async save(request: ArtifactSaveRequest) {
    return {
      status: 'failed' as const,
      key: artifactCacheKey(request.identity),
      savedBytes: 0,
      diagnostics: [{ level: 'error' as const, code: 'save-failed', message: 'offline' }],
      durationMs: 0,
    };
  }

  remove(identity: ArtifactIdentity) {
    return this.#fallback.remove(identity);
  }

  prune(policy: ArtifactRetentionPolicy) {
    return this.#fallback.prune(policy);
  }
}

class DelayedRestoreCache implements ArtifactCache {
  readonly id = 'delayed';
  readonly #fallback = new NoopArtifactCache();

  inspect(identity: ArtifactIdentity) {
    return this.#fallback.inspect(identity);
  }

  async restore(request: ArtifactRestoreRequest) {
    await new Promise((resolve) => setTimeout(resolve, 75));
    await writeTool(request.destinationDirectory, 'late cache write');
    return {
      status: 'error' as const,
      key: artifactCacheKey(request.identity),
      restoredBytes: 0,
      diagnostics: [],
      durationMs: 75,
    };
  }

  save(request: ArtifactSaveRequest) {
    return this.#fallback.save(request);
  }

  remove(identity: ArtifactIdentity) {
    return this.#fallback.remove(identity);
  }

  prune(policy: ArtifactRetentionPolicy) {
    return this.#fallback.prune(policy);
  }
}

class FixtureInstaller implements ToolInstaller {
  readonly id = 'fixture-indexer';
  installs = 0;
  validations = 0;
  installStatus: ToolInstallationResult['status'] = 'installed';
  validationStatus: ToolValidationResult['status'] | undefined;

  async install(request: ToolInstallRequest): Promise<ToolInstallationResult> {
    this.installs += 1;
    await writeTool(request.destinationDirectory, 'fixture 1.0.0');
    if (this.installStatus !== 'installed') {
      return { status: this.installStatus, diagnostics: [], durationMs: 1 };
    }
    return {
      status: 'installed',
      manifest: await createInstalledToolManifest(
        request.descriptor,
        request.destinationDirectory,
        [request.descriptor.healthProbe.executable],
      ),
      diagnostics: [],
      durationMs: 1,
    };
  }

  async validate(request: ToolValidationRequest): Promise<ToolValidationResult> {
    this.validations += 1;
    if (this.validationStatus !== undefined) {
      return { status: this.validationStatus, diagnostics: [], durationMs: 1 };
    }
    const content = await readFile(join(request.installationDirectory, 'bin', 'fixture'), 'utf8');
    return {
      status: content === 'fixture 1.0.0' ? 'valid' : 'invalid',
      diagnostics: [],
      durationMs: 1,
    };
  }
}

function manager(cache: ArtifactCache, installer: FixtureInstaller): InstalledToolManager {
  return new InstalledToolManager(cache, new ToolInstallerRegistry([
    { id: installer.id, create: () => installer },
  ]));
}

describe('InstalledToolManager', () => {
  it('produces equivalent normalized manifests for cold and warm acquisition', async () => {
    const workspace = await temporaryDirectory('redline-tool-manager-equivalence-');
    const installer = new FixtureInstaller();
    const acquisition = manager(new LocalFilesystemArtifactCache(join(workspace, 'cache')), installer);
    const cold = await acquisition.acquire({
      descriptor: descriptor(),
      installationDirectory: join(workspace, 'cold'),
      workDirectory: join(workspace, 'work-cold'),
      timeoutMs: 5_000,
    });
    const warm = await acquisition.acquire({
      descriptor: descriptor(),
      installationDirectory: join(workspace, 'warm'),
      workDirectory: join(workspace, 'work-warm'),
      timeoutMs: 5_000,
    });

    expect(cold.status).toBe('ready');
    expect(warm.status).toBe('ready');
    if (cold.status !== 'ready' || warm.status !== 'ready') throw new Error('acquisition failed');
    expect(cold.source).toBe('install');
    expect(warm.source).toBe('cache');
    expect(warm.manifest).toEqual(cold.manifest);
    expect(installer.installs).toBe(1);
    expect(installer.validations).toBe(2);
    expect(await readFile(join(workspace, 'warm', 'bin', 'fixture'), 'utf8')).toBe('fixture 1.0.0');
  });

  it('rejects a health-invalid cache hit and replaces it with a clean installation', async () => {
    const workspace = await temporaryDirectory('redline-tool-manager-invalid-hit-');
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'));
    const selectedDescriptor = descriptor();
    const stale = join(workspace, 'stale');
    await writeTool(stale, 'wrong version');
    await cache.save({
      identity: {
        version: ARTIFACT_CACHE_CONTRACT_VERSION,
        kind: 'installed-tool',
        descriptorDigest: reviewToolDescriptorDigest(selectedDescriptor),
      },
      sourceDirectory: stale,
    });
    const installer = new FixtureInstaller();
    const result = await manager(cache, installer).acquire({
      descriptor: selectedDescriptor,
      installationDirectory: join(workspace, 'selected'),
      workDirectory: join(workspace, 'work'),
      timeoutMs: 5_000,
    });

    expect(result.status).toBe('ready');
    expect(result.status === 'ready' && result.source).toBe('install');
    expect(installer.installs).toBe(1);
    expect(installer.validations).toBe(2);
    expect(result.diagnostics.some((item) => item.code === 'cached-tool-rejected')).toBe(true);
    expect(await readFile(join(workspace, 'selected', 'bin', 'fixture'), 'utf8')).toBe('fixture 1.0.0');
  });

  it('installs successfully when caching is bypassed', async () => {
    const workspace = await temporaryDirectory('redline-tool-manager-bypass-');
    const installer = new FixtureInstaller();
    const result = await manager(new NoopArtifactCache(), installer).acquire({
      descriptor: descriptor(),
      installationDirectory: join(workspace, 'selected'),
      workDirectory: join(workspace, 'work'),
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('ready');
    expect(result.status === 'ready' && result.source).toBe('install');
    expect(installer.installs).toBe(1);
  });

  it('bounds a delayed cache restore without allowing it to mutate the selected destination', async () => {
    const workspace = await temporaryDirectory('redline-tool-manager-cache-timeout-');
    const installer = new FixtureInstaller();
    const destination = join(workspace, 'selected');
    const result = await manager(new DelayedRestoreCache(), installer).acquire({
      descriptor: descriptor(),
      installationDirectory: destination,
      workDirectory: join(workspace, 'work'),
      timeoutMs: 5_000,
      cacheTimeoutMs: 10,
    });
    expect(result.status).toBe('ready');
    expect(result.diagnostics.some((item) => item.code === 'tool-cache-restore-timed-out')).toBe(true);
    expect(await readFile(join(destination, 'bin', 'fixture'), 'utf8')).toBe('fixture 1.0.0');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(join(destination, 'bin', 'fixture'), 'utf8')).toBe('fixture 1.0.0');
    expect((await readdir(workspace)).some((name) => name.startsWith('.selected.cache-'))).toBe(false);
  });

  it('degrades cache backend errors to warnings and still installs the required tool', async () => {
    const workspace = await temporaryDirectory('redline-tool-manager-cache-error-');
    const installer = new FixtureInstaller();
    const result = await manager(new FailingCache(), installer).acquire({
      descriptor: descriptor(),
      installationDirectory: join(workspace, 'selected'),
      workDirectory: join(workspace, 'work'),
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('ready');
    expect(result.status === 'ready' && result.source).toBe('install');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'restore-failed', level: 'warning' }),
      expect.objectContaining({ code: 'save-failed', level: 'warning' }),
    ]));
  });

  it('removes partial installations after installer or validation failure', async () => {
    const workspace = await temporaryDirectory('redline-tool-manager-cleanup-');
    const failedInstaller = new FixtureInstaller();
    failedInstaller.installStatus = 'failed';
    const failedDestination = join(workspace, 'failed');
    const failed = await manager(new NoopArtifactCache(), failedInstaller).acquire({
      descriptor: descriptor(),
      installationDirectory: failedDestination,
      workDirectory: join(workspace, 'work-failed'),
      timeoutMs: 5_000,
    });
    expect(failed.status).toBe('failed');
    await expect(readFile(join(failedDestination, 'bin', 'fixture'))).rejects.toMatchObject({ code: 'ENOENT' });

    const timedOutInstaller = new FixtureInstaller();
    timedOutInstaller.validationStatus = 'timed-out';
    const timedOutDestination = join(workspace, 'timed-out');
    const timedOut = await manager(new NoopArtifactCache(), timedOutInstaller).acquire({
      descriptor: descriptor(),
      installationDirectory: timedOutDestination,
      workDirectory: join(workspace, 'work-timed-out'),
      timeoutMs: 5_000,
    });
    expect(timedOut.status).toBe('timed-out');
    await expect(readFile(join(timedOutDestination, 'bin', 'fixture'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
