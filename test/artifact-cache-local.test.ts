import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactCacheKey } from '../src/artifact-cache/contracts.js';
import { LocalFilesystemArtifactCache } from '../src/artifact-cache/local-filesystem.js';
import { NoopArtifactCache } from '../src/artifact-cache/noop.js';
import type { ToolArtifactIdentity } from '../src/artifact-cache/types.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function identity(character = 'a'): ToolArtifactIdentity {
  return {
    version: 1,
    kind: 'installed-tool',
    descriptorDigest: `sha256:${character.repeat(64)}`,
  };
}

async function createSource(root: string, suffix = ''): Promise<string> {
  const source = join(root, `source${suffix}`);
  await mkdir(join(source, 'bin'), { recursive: true });
  await mkdir(join(source, 'a'), { recursive: true });
  await Promise.all([source, join(source, 'bin'), join(source, 'a')].map((path) => chmod(path, 0o755)));
  await writeFile(join(source, 'bin', 'tool'), `tool${suffix}`);
  await chmod(join(source, 'bin', 'tool'), 0o755);
  await writeFile(join(source, 'a', 'nested.txt'), `nested${suffix}`);
  await writeFile(join(source, 'a-z.txt'), `flat${suffix}`);
  return source;
}

function artifactDirectory(root: string, artifactIdentity: ToolArtifactIdentity): string {
  return join(root, 'artifacts', ...artifactCacheKey(artifactIdentity).split('/'));
}

describe('LocalFilesystemArtifactCache', () => {
  it('atomically saves, inspects, and restores an exact directory payload', async () => {
    const workspace = await temporaryDirectory('redline-cache-');
    const source = await createSource(workspace);
    const cacheRoot = join(workspace, 'cache');
    const cache = new LocalFilesystemArtifactCache(cacheRoot, { now: () => 1_000 });

    const saved = await cache.save({ identity: identity(), sourceDirectory: source });
    expect(saved.status).toBe('saved');
    expect(saved.manifest?.files.map((file) => file.path)).toEqual([
      'a-z.txt',
      'a/nested.txt',
      'bin/tool',
    ]);
    expect((await cache.inspect(identity())).status).toBe('hit');

    const destination = join(workspace, 'restored');
    const restored = await cache.restore({ identity: identity(), destinationDirectory: destination });
    expect(restored.status).toBe('hit');
    expect(await readFile(join(destination, 'bin', 'tool'), 'utf8')).toBe('tool');
    expect(await readFile(join(destination, 'a', 'nested.txt'), 'utf8')).toBe('nested');
    expect((await stat(join(destination, 'bin', 'tool'))).mode & 0o777).toBe(0o755);
    expect((await readdir(workspace)).some((name) => name.startsWith('.restored.restore-'))).toBe(false);
  });

  it('reports misses without creating a restore destination', async () => {
    const workspace = await temporaryDirectory('redline-cache-miss-');
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'));
    const destination = join(workspace, 'missing');
    const restored = await cache.restore({ identity: identity(), destinationDirectory: destination });
    expect(restored.status).toBe('miss');
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites an existing restore destination', async () => {
    const workspace = await temporaryDirectory('redline-cache-existing-');
    const source = await createSource(workspace);
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'));
    await cache.save({ identity: identity(), sourceDirectory: source });
    const destination = join(workspace, 'destination');
    await mkdir(destination);
    await writeFile(join(destination, 'owner.txt'), 'keep');

    const restored = await cache.restore({ identity: identity(), destinationDirectory: destination });
    expect(restored.status).toBe('error');
    expect(restored.diagnostics[0]?.code).toBe('cache-restore-failed');
    expect(await readFile(join(destination, 'owner.txt'), 'utf8')).toBe('keep');
  });

  it('detects and evicts corrupt payloads instead of restoring them', async () => {
    const workspace = await temporaryDirectory('redline-cache-corrupt-');
    const source = await createSource(workspace);
    const cacheRoot = join(workspace, 'cache');
    const cache = new LocalFilesystemArtifactCache(cacheRoot);
    await cache.save({ identity: identity(), sourceDirectory: source });
    await writeFile(join(artifactDirectory(cacheRoot, identity()), 'payload', 'bin', 'tool'), 'tampered');

    const restored = await cache.restore({
      identity: identity(),
      destinationDirectory: join(workspace, 'restored'),
    });
    expect(restored.status).toBe('corrupt');
    expect(restored.diagnostics[0]?.code).toBe('cache-payload-corrupt');
    expect((await cache.inspect(identity())).status).toBe('miss');
  });

  it('treats expired entries as stale and evicts them on restore', async () => {
    const workspace = await temporaryDirectory('redline-cache-expired-');
    const source = await createSource(workspace);
    let now = 1_000;
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'), { now: () => now });
    await cache.save({ identity: identity(), sourceDirectory: source, ttlMs: 100 });
    now = 1_100;
    expect((await cache.inspect(identity())).status).toBe('stale');
    expect((await cache.restore({
      identity: identity(),
      destinationDirectory: join(workspace, 'restored'),
    })).status).toBe('stale');
    expect((await cache.inspect(identity())).status).toBe('miss');
  });

  it('serializes concurrent publishers and exposes only one complete artifact', async () => {
    const workspace = await temporaryDirectory('redline-cache-concurrent-');
    const source = await createSource(workspace);
    const cacheRoot = join(workspace, 'cache');
    const first = new LocalFilesystemArtifactCache(cacheRoot, { staleLockMs: 1, lockRetryMs: 1 });
    const second = new LocalFilesystemArtifactCache(cacheRoot, { staleLockMs: 1, lockRetryMs: 1 });

    const results = await Promise.all([
      first.save({ identity: identity(), sourceDirectory: source }),
      second.save({ identity: identity(), sourceDirectory: source }),
      first.save({ identity: identity(), sourceDirectory: source }),
      second.save({ identity: identity(), sourceDirectory: source }),
    ]);
    expect(results.filter((result) => result.status === 'saved')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'already-present')).toHaveLength(3);
    expect((await first.inspect(identity())).status).toBe('hit');
    expect(await readdir(join(cacheRoot, 'locks'))).toEqual([]);
    const artifactParent = join(cacheRoot, 'artifacts', 'v1', 'installed-tool');
    expect((await readdir(artifactParent)).filter((name) => name.startsWith('.publish-'))).toEqual([]);
  });

  it('reclaims stale publication locks after an interrupted writer', async () => {
    const workspace = await temporaryDirectory('redline-cache-stale-lock-');
    const source = await createSource(workspace);
    const cacheRoot = join(workspace, 'cache');
    const keyParts = artifactCacheKey(identity()).split('/');
    const lockPath = join(cacheRoot, 'locks', `${keyParts[1]}-${keyParts[2]}.lock`);
    await mkdir(lockPath, { recursive: true });
    await utimes(lockPath, new Date(0), new Date(0));
    const cache = new LocalFilesystemArtifactCache(cacheRoot, { staleLockMs: 1 });

    expect((await cache.save({ identity: identity(), sourceDirectory: source })).status).toBe('saved');
    expect((await cache.inspect(identity())).status).toBe('hit');
    expect(await readdir(join(cacheRoot, 'locks'))).toEqual([]);
  });

  it('rejects symbolic links without publishing partial artifacts', async () => {
    const workspace = await temporaryDirectory('redline-cache-symlink-');
    const source = await createSource(workspace);
    await symlink(join(source, 'bin', 'tool'), join(source, 'linked-tool'));
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'));
    const saved = await cache.save({ identity: identity(), sourceDirectory: source });
    expect(saved.status).toBe('failed');
    expect(saved.diagnostics[0]?.message).toContain('must not contain symbolic links');
    expect((await cache.inspect(identity())).status).toBe('miss');
  });

  it('rejects nested empty directories that cannot be reproduced by the file manifest', async () => {
    const workspace = await temporaryDirectory('redline-cache-empty-directory-');
    const source = await createSource(workspace);
    await mkdir(join(source, 'required-empty-directory'));
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'));
    const saved = await cache.save({ identity: identity(), sourceDirectory: source });
    expect(saved.status).toBe('failed');
    expect(saved.diagnostics[0]?.message).toContain('must not contain empty directories');
    expect((await cache.inspect(identity())).status).toBe('miss');
  });

  it('rejects directory modes that cannot be reproduced by the portable manifest', async () => {
    const workspace = await temporaryDirectory('redline-cache-directory-mode-');
    const source = await createSource(workspace);
    await chmod(join(source, 'a'), 0o700);
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'));
    const saved = await cache.save({ identity: identity(), sourceDirectory: source });
    expect(saved.status).toBe('failed');
    expect(saved.diagnostics[0]?.message).toContain('must use mode 0755');
    expect((await cache.inspect(identity())).status).toBe('miss');
  });

  it('rejects manifests that exceed the configured readable bound before publication', async () => {
    const workspace = await temporaryDirectory('redline-cache-manifest-bound-');
    const source = await createSource(workspace);
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'), { maxManifestBytes: 100 });
    const saved = await cache.save({ identity: identity(), sourceDirectory: source });
    expect(saved.status).toBe('failed');
    expect(saved.diagnostics[0]?.message).toContain('cache manifest exceeds 100 bytes');
    expect((await cache.inspect(identity())).status).toBe('miss');
  });

  it('keeps changed identities isolated from existing entries', async () => {
    const workspace = await temporaryDirectory('redline-cache-identity-');
    const source = await createSource(workspace);
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'));
    await cache.save({ identity: identity('a'), sourceDirectory: source });
    expect((await cache.inspect(identity('a'))).status).toBe('hit');
    expect((await cache.inspect(identity('b'))).status).toBe('miss');
  });

  it('prunes abandoned publication and stale-lock directories without touching fresh work', async () => {
    const workspace = await temporaryDirectory('redline-cache-orphans-');
    const cacheRoot = join(workspace, 'cache');
    const [, kind, digest] = artifactCacheKey(identity()).split('/');
    if (kind === undefined || digest === undefined) throw new Error('test cache key is malformed');
    const kindDirectory = join(cacheRoot, 'artifacts', 'v1', kind);
    const oldPublication = join(kindDirectory, `.publish-${digest}-old`);
    const freshPublication = join(kindDirectory, `.publish-${digest}-fresh`);
    const staleLock = join(cacheRoot, 'locks', `${kind}-${digest}.lock.stale.999.1`);
    await mkdir(oldPublication, { recursive: true });
    await mkdir(freshPublication, { recursive: true });
    await mkdir(staleLock, { recursive: true });
    await writeFile(join(oldPublication, 'partial'), 'old');
    await writeFile(join(freshPublication, 'partial'), 'fresh');
    await utimes(oldPublication, new Date(0), new Date(0));
    await utimes(staleLock, new Date(0), new Date(0));

    const cache = new LocalFilesystemArtifactCache(cacheRoot, { staleLockMs: 1_000 });
    const pruned = await cache.prune({ maxEntries: 10 });
    expect(pruned.status).toBe('completed');
    expect(pruned.removedEntries).toBe(1);
    await expect(stat(oldPublication)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(staleLock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(freshPublication)).isDirectory()).toBe(true);
  });

  it('prunes oldest entries by count and bytes without changing retained payloads', async () => {
    const workspace = await temporaryDirectory('redline-cache-prune-');
    const source = await createSource(workspace);
    let now = 1_000;
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'), { now: () => now });
    await cache.save({ identity: identity('a'), sourceDirectory: source });
    now = 2_000;
    await cache.save({ identity: identity('b'), sourceDirectory: source });
    now = 3_000;
    await cache.save({ identity: identity('c'), sourceDirectory: source });

    const pruned = await cache.prune({ maxEntries: 2 });
    expect(pruned.status).toBe('completed');
    expect(pruned.removedEntries).toBe(1);
    expect(pruned.removedBytes).toBeGreaterThan(0);
    expect((await cache.inspect(identity('a'))).status).toBe('miss');
    expect((await cache.inspect(identity('b'))).status).toBe('hit');
    expect((await cache.inspect(identity('c'))).status).toBe('hit');

    const sizePruned = await cache.prune({ maxBytes: 14 });
    expect(sizePruned.status).toBe('completed');
    expect(sizePruned.removedEntries).toBe(1);
    expect((await cache.inspect(identity('b'))).status).toBe('miss');
    expect((await cache.inspect(identity('c'))).status).toBe('hit');
  });

  it('prunes entries older than the configured age', async () => {
    const workspace = await temporaryDirectory('redline-cache-age-');
    const source = await createSource(workspace);
    let now = 1_000;
    const cache = new LocalFilesystemArtifactCache(join(workspace, 'cache'), { now: () => now });
    await cache.save({ identity: identity('a'), sourceDirectory: source });
    now = 3_000;
    await cache.save({ identity: identity('b'), sourceDirectory: source });
    now = 4_000;

    const pruned = await cache.prune({ maxAgeMs: 2_000 });
    expect(pruned.status).toBe('completed');
    expect(pruned.removedEntries).toBe(1);
    expect((await cache.inspect(identity('a'))).status).toBe('miss');
    expect((await cache.inspect(identity('b'))).status).toBe('hit');
  });
});

describe('NoopArtifactCache', () => {
  it('reports explicit bypasses and never touches artifact directories', async () => {
    const workspace = await temporaryDirectory('redline-no-cache-');
    const source = await createSource(workspace);
    const cache = new NoopArtifactCache();
    expect((await cache.inspect(identity())).status).toBe('bypassed');
    expect((await cache.save({ identity: identity(), sourceDirectory: source })).status).toBe('bypassed');
    expect((await cache.restore({
      identity: identity(),
      destinationDirectory: join(workspace, 'restored'),
    })).status).toBe('bypassed');
    expect((await cache.remove(identity())).status).toBe('bypassed');
    expect((await cache.prune({ maxEntries: 1 })).status).toBe('bypassed');
    await expect(stat(join(workspace, 'restored'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
