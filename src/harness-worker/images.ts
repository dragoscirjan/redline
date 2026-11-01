import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { inside } from '../local/process.ts';
import { isRecord as record } from '../process-runner.ts';
import type { HarnessName } from '../harness-executor/types.ts';
export type WorkerHarness = Exclude<HarnessName, 'echo'>;
export interface Identity { readonly harness: WorkerHarness; readonly release: string; readonly revision: string; readonly harnessVersion: string }
export class WorkerFault extends Error {}

export interface WorkerImage {
  readonly reference: string;
  readonly platforms: readonly string[];
  readonly identity: Identity;
  readonly development: boolean;
}
export interface WorkerManifest {
  readonly version: 1;
  readonly release: string;
  readonly revision: string;
  readonly development: boolean;
  readonly images: Readonly<Record<WorkerHarness, { readonly reference: string; readonly harnessVersion: string; readonly platforms: readonly string[] }>>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
}
export function parseWorkerManifest(value: unknown, release: string, allowDevelopment: boolean): WorkerManifest {
  if (!record(value) || !keys(value, ['version', 'release', 'revision', 'development', 'images']) || value.version !== 1
    || value.release !== release || typeof value.development !== 'boolean' || (value.development && !allowDevelopment)
    || typeof value.revision !== 'string' || !/^[0-9a-f]{40}$/u.test(value.revision) || !record(value.images)
    || !keys(value.images, ['pi', 'opencode'])) throw new WorkerFault('Release-matched worker images are unavailable');
  const images: Partial<Record<WorkerHarness, WorkerManifest['images'][WorkerHarness]>> = {};
  for (const harness of ['pi', 'opencode'] as const) {
    const image = value.images[harness];
    if (!record(image) || !keys(image, ['reference', 'harnessVersion', 'platforms']) || typeof image.reference !== 'string'
      || typeof image.harnessVersion !== 'string' || image.harnessVersion.length > 64 || !image.harnessVersion.length
      || !Array.isArray(image.platforms) || image.platforms.length < 1 || image.platforms.length > 2
      || !image.platforms.every(p => p === 'linux/amd64' || p === 'linux/arm64') || new Set(image.platforms).size !== image.platforms.length) throw new WorkerFault('Invalid worker image manifest');
    const production = new RegExp(`^ghcr\\.io/dragoscirjan/redline-${harness}@sha256:[0-9a-f]{64}$`, 'u').test(image.reference);
    const local = /^sha256:[0-9a-f]{64}$/u.test(image.reference);
    if ((!value.development && (!production || image.platforms.length !== 2)) || (value.development && !local)) throw new WorkerFault('Worker images must use immutable matching digests');
    images[harness] = { reference: image.reference, harnessVersion: image.harnessVersion, platforms: image.platforms };
  }
  const { pi, opencode } = images;
  if (pi === undefined || opencode === undefined) throw new WorkerFault();
  return { version: 1, release, revision: value.revision, development: value.development, images: { pi, opencode } };
}
export async function loadWorkerImage(harness: WorkerHarness, repository: string, override?: string): Promise<WorkerImage> {
  const pkg: unknown = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  if (!record(pkg) || typeof pkg.version !== 'string') throw new WorkerFault('Package identity unavailable');
  const path = override ?? new URL('./worker-images.json', import.meta.url);
  if (override !== undefined && inside(repository, await realpath(override))) throw new WorkerFault('Worker manifest must be outside the reviewed repository');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 || (process.platform !== 'win32' && (info.mode & 0o022) !== 0)) throw new WorkerFault('Invalid worker image manifest');
    const manifest = parseWorkerManifest(JSON.parse(await handle.readFile('utf8')), pkg.version, override !== undefined);
    const image = manifest.images[harness];
    const identity = { harness, release: manifest.release, revision: manifest.revision, harnessVersion: image.harnessVersion };
    return { reference: image.reference, platforms: image.platforms, identity, development: manifest.development };
  } finally { await handle.close(); }
}
