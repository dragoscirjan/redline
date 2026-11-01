import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { cancellableSpawner, inside } from '../local/process.ts';
import { runBoundedProcess } from '../process-runner.ts';
import { record, WorkerFault } from './contract.ts';
import type { WorkerImage } from './images.ts';

export interface ContainerLimits { readonly memoryMiB: number; readonly scratchMiB: number; readonly cpus: number; readonly pids: number }
export const DEFAULT_CONTAINER_LIMITS: ContainerLimits = Object.freeze({ memoryMiB: 1024, scratchMiB: 256, cpus: 1, pids: 128 });
export function containerLimits(value: ContainerLimits): ContainerLimits {
  for (const [key, min, max] of [['memoryMiB', 256, 8192], ['scratchMiB', 64, 1024], ['pids', 32, 512]] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) throw new WorkerFault('Invalid container resource budget');
  }
  if (!Number.isFinite(value.cpus) || value.cpus < 0.25 || value.cpus > 4) throw new WorkerFault('Invalid container CPU budget');
  return { ...value };
}
export const MANAGED = 'io.redline.managed';
export const OWNER = 'io.redline.owner';
export const JOB = 'io.redline.job';
export const EXPIRY = 'io.redline.expires';
export function containerArguments(image: WorkerImage, owner: string, jobId: string, timeoutMs: number, limits: ContainerLimits): string[] {
  containerLimits(limits);
  return ['create', '--name', 'redline-' + jobId,
    '--label', MANAGED + '=worker/v1', '--label', OWNER + '=' + owner, '--label', JOB + '=' + jobId,
    '--label', EXPIRY + '=' + String(Date.now() + timeoutMs + 10_000),
    '--interactive', '--init', '--read-only', '--user', '10001:10001', '--network', 'none', '--ipc', 'private', '--cgroupns', 'private',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', String(limits.pids), '--cpus', String(limits.cpus),
    '--memory', String(limits.memoryMiB * 1024 * 1024), '--memory-swap', String(limits.memoryMiB * 1024 * 1024),
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.scratchMiB * 1024 * 1024},mode=1777`,
    '--ulimit', 'nofile=1024:1024', image.reference];
}
export class DockerClient {
  readonly command: string;
  readonly owner: string;
  private readonly directory: string;
  private readonly env: NodeJS.ProcessEnv;
  private constructor(command: string, directory: string, env: NodeJS.ProcessEnv, owner: string) {
    this.command = command; this.directory = directory; this.env = env; this.owner = owner;
  }
  static async create(command: string, repository: string, state: string, host: NodeJS.ProcessEnv): Promise<DockerClient> {
    const parent = await realpath(tmpdir());
    if (inside(repository, parent)) throw new WorkerFault('Container client scratch must be outside the reviewed repository');
    if ((host.DOCKER_CONTEXT !== undefined && host.DOCKER_CONTEXT !== 'default')
      || (host.DOCKER_HOST !== undefined && !/^unix:\/\/\//u.test(host.DOCKER_HOST))) throw new WorkerFault('Initial Docker support requires a local Linux Unix-socket engine');
    const directory = await mkdtemp(join(parent, 'redline-docker-'));
    try {
      const config = join(directory, 'config'); await mkdir(config, { mode: 0o700 });
      await writeFile(join(config, 'config.json'), '{"auths":{}}\n', { mode: 0o600 });
      const env: NodeJS.ProcessEnv = { PATH: dirname(command), HOME: directory, DOCKER_CONFIG: config, LANG: 'C.UTF-8',
        ...(host.DOCKER_HOST === undefined ? {} : { DOCKER_HOST: host.DOCKER_HOST }) };
      const owner = createHash('sha256').update(String(process.getuid?.()) + '\0' + state).digest('hex');
      return new DockerClient(command, directory, env, owner);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async run(args: readonly string[], signal: AbortSignal, timeoutMs = 30_000, limit = 64 * 1024): Promise<string> {
    signal.throwIfAborted();
    const result = await runBoundedProcess(cancellableSpawner(signal), {
      command: this.command, args, cwd: this.directory, env: this.env, timeoutMs, stdoutLimitBytes: limit,
    });
    signal.throwIfAborted();
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) throw new WorkerFault(`Docker ${args[0] ?? 'operation'} failed`);
    return result.stdout.trim();
  }
  async preflight(image: WorkerImage, signal: AbortSignal): Promise<void> {
    if (process.platform !== 'linux') throw new WorkerFault('Docker isolation is initially certified on Linux hosts only');
    const format = '{"os":{{json .OSType}},"arch":{{json .Architecture}},"security":{{json .SecurityOptions}},"memory":{{json .MemoryLimit}},"swap":{{json .SwapLimit}},"pids":{{json .PidsLimit}},"cpu":{{json .CPUCfsQuota}}}';
    const info: unknown = JSON.parse(await this.run(['info', '--format', format], signal));
    if (!record(info) || info.os !== 'linux' || !Array.isArray(info.security) || !info.security.includes('name=seccomp,profile=builtin')
      || info.memory !== true || info.swap !== true || info.pids !== true || info.cpu !== true) throw new WorkerFault('Docker cannot enforce the required kernel/resource profile');
    const arch = info.arch === 'x86_64' ? 'amd64' : info.arch === 'aarch64' ? 'arm64' : info.arch;
    if (!image.platforms.includes('linux/' + String(arch))) throw new WorkerFault('Worker image is unavailable for this engine architecture');
    try { await this.run(['image', 'inspect', image.reference, '--format', '{{.Id}}'], signal); }
    catch {
      if (image.development) throw new WorkerFault('Local worker image is missing; rebuild it');
      await this.run(['pull', image.reference], signal, 120_000, 1024 * 1024);
    }
    const raw: unknown = JSON.parse(await this.run(['image', 'inspect', image.reference, '--format', '{"user":{{json .Config.User}},"entrypoint":{{json .Config.Entrypoint}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"kind":{{json (index .Config.Labels "io.redline.source-kind")}}}'], signal));
    if (!record(raw) || raw.user !== '10001:10001' || JSON.stringify(raw.entrypoint) !== '["node","/opt/redline/bin/redline-worker.mjs"]'
      || raw.revision !== image.identity.revision || (!image.development && raw.kind !== 'release')) throw new WorkerFault('Worker image metadata does not match its manifest');
    await this.reconcile(signal);
  }
  attach(id: string): { child: ChildProcessWithoutNullStreams; exit: Promise<number | null> } {
    if (!/^[0-9a-f]{64}$/u.test(id)) throw new WorkerFault('Invalid owned container identifier');
    const child = spawn(this.command, ['start', '--attach', '--interactive', id], { cwd: this.directory, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', () => undefined);
    const exit = new Promise<number | null>((resolve, reject) => { child.once('error', () => reject(new WorkerFault('Docker attach failed'))); child.once('close', resolve); });
    // The caller may learn about an attach error through the input stream first.
    void exit.catch(() => undefined);
    return { child, exit };
  }
  async remove(identifier: string, jobId: string): Promise<void> {
    const signal = AbortSignal.timeout(10_000);
    const raw: unknown = JSON.parse(await this.run(['container', 'inspect', identifier, '--format', '{{json .Config.Labels}}'], signal));
    if (!record(raw) || raw[MANAGED] !== 'worker/v1' || raw[OWNER] !== this.owner || raw[JOB] !== jobId) throw new WorkerFault('Container ownership mismatch; refusing cleanup');
    await this.run(['rm', '--force', identifier], signal);
  }
  private async reconcile(signal: AbortSignal): Promise<void> {
    let ids: string[];
    try {
      const listed = await this.run(['container', 'ls', '--all', '--no-trunc', '--filter', `label=${MANAGED}=worker/v1`, '--filter', `label=${OWNER}=${this.owner}`, '--format', '{{.ID}}'], signal);
      ids = listed === '' ? [] : listed.split('\n');
    } catch { signal.throwIfAborted(); return; }
    // Crash leftovers belong to other invocations. Their cleanup cannot disable a fresh review.
    for (const id of ids.slice(0, 128)) {
      signal.throwIfAborted();
      if (!/^[a-f0-9]{64}$/u.test(id)) continue;
      try {
        const labels: unknown = JSON.parse(await this.run(['container', 'inspect', id, '--format', '{{json .Config.Labels}}'], signal));
        if (!record(labels) || labels[OWNER] !== this.owner || labels[MANAGED] !== 'worker/v1') continue;
        const expiry = Number(labels[EXPIRY]); signal.throwIfAborted();
        if (Number.isSafeInteger(expiry) && expiry > 0 && expiry < Date.now() && typeof labels[JOB] === 'string') await this.remove(id, labels[JOB]);
      } catch { signal.throwIfAborted(); }
    }
    signal.throwIfAborted();
  }
  async close(): Promise<void> { await rm(this.directory, { recursive: true, force: true }); }
}
