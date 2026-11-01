import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { containerArguments, containerLimits, DEFAULT_CONTAINER_LIMITS, DockerClient, JOB, MANAGED, OWNER } from '../src/harness-worker/docker-client.ts';
import { parseWorkerManifest, type WorkerImage } from '../src/harness-worker/images.ts';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const image: WorkerImage = { reference: 'ghcr.io/dragoscirjan/redline-pi@sha256:' + 'a'.repeat(64), platforms: ['linux/amd64', 'linux/arm64'], development: false,
  identity: { harness: 'pi', release: '1.2.0', revision: 'a'.repeat(40), harnessVersion: '1.4.0' } };
const job = '00000000-0000-4000-8000-000000000000';
describe('fixed isolation policy', () => {
  it('has no mounts, ambient environment, host networking, privilege or unbounded resource flags', () => {
    const args = containerArguments(image, 'owner', job, 1000, DEFAULT_CONTAINER_LIMITS);
    for (const flag of ['--read-only', '--init', '--cap-drop', '--security-opt', '--memory', '--memory-swap', '--cpus', '--pids-limit', '--ulimit']) expect(args).toContain(flag);
    expect(args[args.indexOf('--user') + 1]).toBe('10001:10001'); expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL'); expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges=true');
    expect(args[args.indexOf('--tmpfs') + 1]).toContain('noexec,nosuid,nodev');
    expect(args.some(a => /^(?:--privileged|--volume|--mount|--env|--publish|--device|--pid)$/u.test(a))).toBe(false);
    expect(args.at(-1)).toBe(image.reference);
  });
  it('enforces every trusted resource boundary instead of clamping or ignoring invalid values', () => {
    for (const patch of [{ memoryMiB: 255 }, { memoryMiB: 8193 }, { scratchMiB: 63 }, { scratchMiB: 1025 }, { pids: 31 }, { pids: 513 }, { pids: 32.5 }, { cpus: 0.24 }, { cpus: 4.01 }, { cpus: NaN }]) {
      expect(() => containerLimits({ ...DEFAULT_CONTAINER_LIMITS, ...patch })).toThrow();
    }
    expect(containerLimits({ memoryMiB: 256, scratchMiB: 64, pids: 32, cpus: 0.25 })).toMatchObject({ memoryMiB: 256 });
  });
  it('requires exact release-matched GHCR indexes and both architectures; development is explicit and local-only', () => {
    const manifest = { version: 1, release: '1.2.0', revision: image.identity.revision, development: false, images: {
      pi: { reference: image.reference, harnessVersion: '1.4.0', platforms: image.platforms },
      opencode: { reference: 'ghcr.io/dragoscirjan/redline-opencode@sha256:' + 'b'.repeat(64), harnessVersion: '1.18.34', platforms: image.platforms },
    } };
    expect(parseWorkerManifest(manifest, '1.2.0', false).development).toBe(false);
    expect(() => parseWorkerManifest(manifest, '1.3.0', false)).toThrow();
    for (const ref of ['ghcr.io/dragoscirjan/redline-pi:latest', 'ghcr.io/someone/pi@sha256:' + 'a'.repeat(64), manifest.images.opencode.reference]) {
      expect(() => parseWorkerManifest({ ...manifest, images: { ...manifest.images, pi: { ...manifest.images.pi, reference: ref } } }, '1.2.0', false)).toThrow();
    }
    expect(() => parseWorkerManifest({ ...manifest, images: { ...manifest.images, pi: { ...manifest.images.pi, platforms: ['linux/amd64'] } } }, '1.2.0', false)).toThrow();
    const local = { ...manifest, development: true, images: { pi: { ...manifest.images.pi, reference: 'sha256:' + 'a'.repeat(64) }, opencode: { ...manifest.images.opencode, reference: 'sha256:' + 'b'.repeat(64) } } };
    expect(() => parseWorkerManifest(local, '1.2.0', false)).toThrow(); expect(parseWorkerManifest(local, '1.2.0', true).development).toBe(true);
  });
});
describe.runIf(process.platform === 'linux')('private Docker controller', () => {
  async function client() {
    const root = await mkdtemp(join(tmpdir(), 'redline-controller-test-')); roots.push(root); const repository = join(root, 'repository'); await mkdir(repository);
    return DockerClient.create(process.execPath, repository, join(root, 'state'), { PATH: process.env.PATH, HOME: root, GH_TOKEN: 'synthetic-gh',
      REDLINE_MODEL_AUTH: 'synthetic-model', SSH_AUTH_SOCK: '/synthetic-agent', DOCKER_CONFIG: '/synthetic-auth-config' });
  }
  it('constructs an empty private Docker environment instead of forwarding host credentials or config', async () => {
    const c = await client();
    try {
      const env = JSON.parse(await c.run(['-e', 'console.log(JSON.stringify(process.env))'], AbortSignal.timeout(5000)));
      expect(env.GH_TOKEN).toBeUndefined(); expect(env.REDLINE_MODEL_AUTH).toBeUndefined(); expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.DOCKER_CONFIG).not.toBe('/synthetic-auth-config'); expect(env.HOME).toContain('redline-docker-');
    } finally { await c.close(); }
  });
  it('rejects missing enforcement and non-release images before launching a worker', async () => {
    const c = await client(); let kind = 'development'; let enforcement = true;
    const run = vi.spyOn(c, 'run').mockImplementation(async args => args[0] === 'info'
      ? JSON.stringify({ os: 'linux', arch: 'amd64', security: ['name=seccomp,profile=builtin'], memory: enforcement, swap: true, pids: true, cpu: true })
      : args.includes('{{.Id}}') ? 'sha256:' + 'a'.repeat(64) : JSON.stringify({ user: '10001:10001', entrypoint: ['node', '/opt/redline/bin/redline-worker.mjs'], revision: image.identity.revision, kind }));
    try {
      await expect(c.preflight(image, AbortSignal.timeout(5000))).rejects.toThrow('metadata'); kind = 'release'; enforcement = false;
      await expect(c.preflight(image, AbortSignal.timeout(5000))).rejects.toThrow('enforce'); expect(run.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
    } finally { await c.close(); }
  });
  it('does not block a fresh review when another run removes or cannot remove a stale owned container', async () => {
    const c = await client(); const gone = 'a'.repeat(64); const stuck = 'b'.repeat(64);
    const run = vi.spyOn(c, 'run').mockImplementation(async args => {
      if (args[0] === 'info') return JSON.stringify({ os: 'linux', arch: 'amd64', security: ['name=seccomp,profile=builtin'], memory: true, swap: true, pids: true, cpu: true });
      if (args[0] === 'image') return args.includes('{{.Id}}') ? 'sha256:' + 'a'.repeat(64) : JSON.stringify({ user: '10001:10001', entrypoint: ['node', '/opt/redline/bin/redline-worker.mjs'], revision: image.identity.revision, kind: 'release' });
      if (args[1] === 'ls') return gone + '\n' + stuck;
      if (args[0] === 'container' && args[2] === stuck) return JSON.stringify({ [MANAGED]: 'worker/v1', [OWNER]: c.owner, [JOB]: job, 'io.redline.expires': String(Date.now() - 1) });
      throw new Error('Concurrent removal or unavailable cleanup');
    });
    try {
      await expect(c.preflight(image, AbortSignal.timeout(5000))).resolves.toBeUndefined();
      expect(run.mock.calls.some(([args]) => args[0] === 'rm' && args.at(-1) === stuck)).toBe(true);
      expect(run.mock.calls.some(([args]) => args[0] === 'rm' && args.at(-1) === gone)).toBe(false);
    } finally { await c.close(); }
  });
  it('propagates cancellation instead of swallowing it as a reconciliation race', async () => {
    const c = await client(); const controller = new AbortController(); const reason = new Error('Original cancellation');
    vi.spyOn(c, 'run').mockImplementation(async args => {
      if (args[0] === 'info') return JSON.stringify({ os: 'linux', arch: 'amd64', security: ['name=seccomp,profile=builtin'], memory: true, swap: true, pids: true, cpu: true });
      if (args[0] === 'image') return args.includes('{{.Id}}') ? 'sha256:' + 'a'.repeat(64) : JSON.stringify({ user: '10001:10001', entrypoint: ['node', '/opt/redline/bin/redline-worker.mjs'], revision: image.identity.revision, kind: 'release' });
      controller.abort(reason); throw new Error('Cleanup interrupted');
    });
    try { await expect(c.preflight(image, controller.signal)).rejects.toBe(reason); } finally { await c.close(); }
  });
  it('refuses cleanup unless marker, owner and exact job all match', async () => {
    const c = await client();
    const run = vi.spyOn(c, 'run').mockResolvedValue(JSON.stringify({ [MANAGED]: 'worker/v1', [OWNER]: 'someone-else', [JOB]: job }));
    try { await expect(c.remove('a'.repeat(64), job)).rejects.toThrow('ownership'); expect(run.mock.calls).toHaveLength(1); }
    finally { await c.close(); }
  });
});
