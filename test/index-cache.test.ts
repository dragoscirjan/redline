import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireBaseIndex, MAX_INDEX_CACHE_ENTRIES, type BaseIndexIdentity, type BaseIndexLease } from '../src/code-index/cache.ts';
import { executable } from '../src/local/process.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const identity: BaseIndexIdentity = { repository: 'local/fixture', base: 'a'.repeat(40), provider: 'cgc', providerVersion: '0.5.7', configuration: 'fixed-config', platform: 'fixture-platform' };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'redline-index-cache-'))); roots.push(root);
  const repository = join(root, 'repo'); await mkdir(repository);
  const cache = join(root, 'indexes');
  const path = process.env.PATH ?? process.env.Path ?? '';
  const python = await executable('python3', path, repository).catch(() => executable('python', path, repository));
  const env = { PATH: path, HOME: root, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: root, TMP: root, PYTHONDONTWRITEBYTECODE: '1' };
  const acquire = (value = identity, signal = new AbortController().signal) => acquireBaseIndex(cache, repository, value, python, env, signal, 10_000);
  return { root, repository, cache, acquire, python, env };
}
async function commit(lease: BaseIndexLease, value = identity): Promise<void> {
  await mkdir(join(lease.directory, 'cache/database'), { recursive: true });
  await writeFile(join(lease.directory, 'cache/database/fixture'), 'bounded graph');
  await writeFile(join(lease.directory, 'cache/state.json'), JSON.stringify({
    version: 1, repository: value.repository, revision: value.base, provider: value.provider,
    providerVersion: value.providerVersion, configuration: value.configuration, sourceRoot: join(lease.directory, 'base'),
  }));
  await lease.release();
}

it('reuses exact identity and separates base, repository, provider, version, configuration, and platform', async () => {
  const f = await fixture(); const first = await f.acquire(); expect(first.restored).toBe(false); await commit(first);
  const second = await f.acquire(); expect(second.key).toBe(first.key); expect(second.restored).toBe(true); await commit(second);
  for (const changed of [{ base: 'b'.repeat(40) }, { repository: 'local/another' }, { provider: 'gitnexus' }, { providerVersion: 'other' }, { configuration: 'new-config' }, { platform: 'other-platform' }]) {
    const value = { ...identity, ...changed }; const next = await f.acquire(value);
    expect(next.key).not.toBe(first.key); expect(next.restored).toBe(false); await commit(next, value);
  }
});

it('serializes ownership, releases after cancellation, and does not publish partial state', async () => {
  const f = await fixture(); const first = await f.acquire();
  const controller = new AbortController();
  const waiting = f.acquire(identity, controller.signal); controller.abort();
  await expect(waiting).rejects.toThrow();
  await first.release(); // no validated provider state: discard partial entry
  const next = await f.acquire(); expect(next.restored).toBe(false); await commit(next);
  const third = await f.acquire(); expect(third.restored).toBe(true); await commit(third);
});

it('does not follow cached directory links and leaves owned fixture sentinels untouched', async () => {
  const f = await fixture(); const first = await f.acquire(); await commit(first);
  const outside = join(f.root, 'sentinel'); await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'fixture sentinel');
  await symlink(outside, join(first.directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const next = await f.acquire(); expect(next.restored).toBe(false);
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('fixture sentinel');
  expect((await readdir(next.directory)).includes('escape')).toBe(false); await next.release();
});

it('refuses a cache root redirected into reviewed content before creating directories', async () => {
  const f = await fixture(); const alias = join(f.root, 'alias');
  await symlink(f.repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(acquireBaseIndex(join(alias, 'cache/new'), f.repository, identity, f.python, f.env, new AbortController().signal, 1000)).rejects.toThrow('inside reviewed repository');
  expect(await readdir(f.repository)).toEqual([]);
});

it('accepts a normal application parent while keeping the cache itself private', async () => {
  const f = await fixture(); await mkdir(f.cache, { mode: 0o755 });
  if (process.platform !== 'win32') await chmod(f.cache, 0o755);
  const lease = await acquireBaseIndex(join(f.cache, 'indexes/v1'), f.repository, identity, f.python, f.env, new AbortController().signal, 1000, f.cache);
  await lease.release();
});

it('refuses links in managed cache parents without writing through them', async () => {
  const f = await fixture(); await mkdir(f.cache, { mode: 0o700 });
  const sentinel = join(f.root, 'sentinel'); await mkdir(sentinel);
  await writeFile(join(sentinel, 'keep'), 'fixture data');
  await symlink(sentinel, join(f.cache, 'indexes'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(acquireBaseIndex(join(f.cache, 'indexes/v1'), f.repository, identity, f.python, f.env, new AbortController().signal, 1000, f.cache)).rejects.toThrow('unsafe index-cache parent');
  expect(await readdir(sentinel)).toEqual(['keep']);
});

it('bounds completed cache retention and never removes unrelated files', async () => {
  const f = await fixture(); await mkdir(f.cache, { mode: 0o700 });
  await writeFile(join(f.cache, 'owner-note.txt'), 'unrelated owned fixture data');
  const unknown = join(f.cache, '0'.repeat(64)); await mkdir(unknown); await writeFile(join(unknown, 'keep'), 'unmarked owned fixture data');
  for (let index = 0; index < MAX_INDEX_CACHE_ENTRIES + 3; index += 1) {
    const value = { ...identity, base: index.toString(16).padStart(40, '0') };
    const lease = await f.acquire(value); await commit(lease, value);
  }
  const markers = await Promise.all((await readdir(f.cache)).filter((name) => /^[a-f0-9]{64}$/u.test(name))
    .map((name) => readFile(join(f.cache, name, 'entry.json'), 'utf8').then((text) => JSON.parse(text), () => null)));
  expect(markers.filter((item) => item?.kind === 'redline-base-index').length).toBeLessThanOrEqual(MAX_INDEX_CACHE_ENTRIES);
  expect(await readFile(join(unknown, 'keep'), 'utf8')).toBe('unmarked owned fixture data');
  expect(await readFile(join(f.cache, 'owner-note.txt'), 'utf8')).toBe('unrelated owned fixture data');
});
