/** Private exact-base state; retained graphs select context but never supply review evidence. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_INDEX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_INDEX_CACHE_ENTRIES = 8;
const MAX_TREE_ENTRIES = 100_000;
const KEY = /^[a-f0-9]{64}$/u;
export interface BaseIndexIdentity {
  readonly repository: string;
  readonly base: string;
  readonly provider: string;
  readonly providerVersion: string;
  readonly configuration: string;
  readonly platform: string;
}
export interface BaseIndexLease {
  readonly directory: string;
  readonly key: string;
  readonly restored: boolean;
  release(): Promise<void>;
}
function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}
async function jsonFile(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new Error('invalid cache metadata');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer);
    if (bytesRead > 4096) throw new Error('oversized cache metadata');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally { await handle.close(); }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('index cache must be a private regular directory');
  }
}
async function treeBytes(root: string): Promise<number> {
  const pending = [root]; let count = 0; let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe cache tree');
    const names = await readdir(directory);
    if (names.length + count > MAX_TREE_ENTRIES) throw new Error('cache entry limit exceeded');
    for (const name of names) {
      if (++count > MAX_TREE_ENTRIES) throw new Error('cache entry limit exceeded');
      const path = join(directory, name); const entry = await lstat(path);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || (entry.isFile() && entry.nlink !== 1)) throw new Error('unsafe cache entry');
      if (entry.isDirectory()) pending.push(path);
      else bytes += entry.size;
      if (bytes > MAX_INDEX_CACHE_BYTES) throw new Error('index cache byte limit exceeded');
    }
  }
  return bytes;
}

async function lock(root: string, python: string, environment: NodeJS.ProcessEnv, signal: AbortSignal, waitMs: number): Promise<() => Promise<void>> {
  const path = join(root, 'index.lock');
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (info !== undefined && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1)) throw new Error('unsafe index lock');
  const child = spawn(python, ['-I', '-B', fileURLToPath(new URL('./lock.py', import.meta.url)), path, String(Math.max(1, waitMs) / 1000)], {
    env: environment, cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdin.on('error', () => undefined);
  child.stderr.resume();
  const exit = new Promise<void>((resolve) => { child.once('error', () => resolve()); child.once('close', () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      let text = ''; let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', abort);
        if (error === undefined) resolve(); else { child.kill(); reject(error); }
      };
      const abort = (): void => finish(new Error('index-cache wait cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', () => finish(new Error('index lock unavailable')));
      child.once('close', () => finish(new Error('index cache busy or unavailable')));
      child.stdout.on('data', (data: Buffer) => {
        text += data.toString('utf8');
        if (text === 'locked\n' || text === 'locked\r\n') finish();
        else if (text.length > 32) finish(new Error('invalid lock handshake'));
      });
      if (signal.aborted) abort();
    });
  } catch (error) { await exit; throw error; }
  // Keep the lock during handled cancellation until the provider has stopped.
  // Kernel locks release on helper exit; stdin EOF handles an owner crash.
  return async () => { child.stdin.end(); await exit; };
}

async function prune(root: string, current: string): Promise<void> {
  const entries: { key: string; bytes: number; used: number }[] = [];
  for (const key of (await readdir(root)).filter((name) => KEY.test(name))) {
    const directory = join(root, key);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const metadata = await jsonFile(join(directory, 'entry.json')).catch(() => undefined);
    if (!object(metadata) || metadata.version !== 1 || metadata.kind !== 'redline-base-index' || typeof metadata.identity !== 'string'
      || createHash('sha256').update(metadata.identity).digest('hex') !== key) continue;
    try {
      const bytes = await treeBytes(directory);
      entries.push({ key, bytes, used: object(metadata) && typeof metadata.used === 'number' ? Math.min(Date.now(), metadata.used) : 0 });
    } catch { if (key !== current) await rm(directory, { recursive: true, force: true }); }
  }
  entries.sort((a, b) => a.used - b.used || a.key.localeCompare(b.key));
  let bytes = entries.reduce((total, entry) => total + entry.bytes, 0); let count = entries.length;
  for (const entry of entries) {
    if (count <= MAX_INDEX_CACHE_ENTRIES && bytes <= MAX_INDEX_CACHE_BYTES) break;
    if (entry.key === current) continue;
    await rm(join(root, entry.key), { recursive: true, force: true }); bytes -= entry.bytes; count -= 1;
  }
}

export async function acquireBaseIndex(root: string, repositoryDirectory: string, identity: BaseIndexIdentity,
  python: string, environment: NodeJS.ProcessEnv, signal: AbortSignal, waitMs: number, anchor = root): Promise<BaseIndexLease> {
  signal.throwIfAborted();
  let ancestor = root;
  while (true) {
    const canonical = await realpath(ancestor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (canonical !== undefined) {
      if (inside(repositoryDirectory, canonical)) throw new Error('index cache is inside reviewed repository');
      break;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('index cache has no existing ancestor');
    ancestor = parent;
  }
  if (!inside(anchor, root)) throw new Error('index cache escaped its state namespace');
  const suffix = relative(anchor, root);
  // The application parent may also hold public tool binaries. Require
  // privacy on the cache root, not by chmod-ing an existing parent.
  await mkdir(anchor, { recursive: true, mode: 0o700 });
  const anchorInfo = await lstat(anchor);
  if (!anchorInfo.isDirectory() || anchorInfo.isSymbolicLink()) throw new Error('unsafe index-cache anchor');
  anchor = await realpath(anchor);
  let cursor = anchor;
  for (const part of suffix.split(/[\\/]/u).filter(Boolean)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('unsafe index-cache parent');
  }
  root = join(anchor, suffix);
  await privateDirectory(root); root = await realpath(root);
  if (inside(repositoryDirectory, root)) throw new Error('index cache is inside reviewed repository');
  const unlock = await lock(root, python, environment, signal, waitMs);
  const encoded = JSON.stringify(identity);
  const key = createHash('sha256').update(encoded).digest('hex');
  const directory = join(root, key);
  let restored = false;
  try {
    if ((await readdir(root)).length > 128) throw new Error('index cache directory limit exceeded');
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    const metadata = info?.isDirectory() && !info.isSymbolicLink()
      ? await jsonFile(join(directory, 'entry.json')).catch(() => undefined) : undefined;
    if (object(metadata) && metadata.version === 1 && metadata.kind === 'redline-base-index' && metadata.ready === true && metadata.identity === encoded) {
      restored = await treeBytes(directory).then(() => true, () => false);
    }
    if (!restored) {
      await rm(directory, { recursive: true, force: true }); await privateDirectory(directory);
      await writeFile(join(directory, 'entry.json'), JSON.stringify({ version: 1, kind: 'redline-base-index', identity: encoded, ready: false, used: Date.now() }), { mode: 0o600 });
    }
    // Refresh base bytes from immutable Git data; keep their pathname stable
    // because CGC stores absolute paths. Retained source is never trusted.
    await rm(join(directory, 'base'), { recursive: true, force: true });
    await prune(root, key);
  } catch (error) { await unlock(); throw error; }
  let released = false;
  return {
    directory, key, restored,
    release: async () => {
      if (released) return;
      released = true;
      try {
        const state = await jsonFile(join(directory, 'cache/state.json')).catch(() => undefined);
        const valid = object(state) && state.version === 1 && state.repository === identity.repository && state.revision === identity.base
          && state.provider === identity.provider && state.providerVersion === identity.providerVersion
          && state.configuration === identity.configuration && state.sourceRoot === join(directory, 'base');
        if (valid) {
          await treeBytes(directory);
          const temporary = join(directory, '.entry.tmp');
          await writeFile(temporary, JSON.stringify({ version: 1, kind: 'redline-base-index', identity: encoded, ready: true, used: Date.now() }), { mode: 0o600 });
          await rename(temporary, join(directory, 'entry.json'));
          await prune(root, key);
        } else await rm(directory, { recursive: true, force: true });
      } catch { await rm(directory, { recursive: true, force: true }); }
      finally { await unlock(); }
    },
  };
}
