/** Local host processes: explicit executable paths, bounded output, no shell. */
import { spawn } from 'node:child_process';
import { access, lstat, open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ProcessSpawner } from '../process-runner.ts';

export class LocalOperationError extends Error {}

export function gitEnvironment(command: string, host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: dirname(command), SystemRoot: host.SystemRoot ?? host.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
  };
}

export function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

export async function repositoryBoundary(directory: string): Promise<string> {
  let current = directory;
  while (true) {
    if (await lstat(join(current, '.git')).then(() => true, () => false)) return current;
    const parent = dirname(current);
    if (parent === current) throw new LocalOperationError('a non-bare Git working tree is required');
    current = parent;
  }
}

export async function executable(name: string, path: string, repository: string): Promise<string> {
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory) || inside(repository, directory)) continue;
    const canonicalDirectory = await realpath(directory).catch(() => undefined);
    if (canonicalDirectory === undefined || inside(repository, canonicalDirectory)) continue;
    for (const suffix of process.platform === 'win32' ? ['.exe'] : ['']) {
      const candidate = await realpath(join(directory, name + suffix)).catch(() => undefined);
      if (candidate === undefined || inside(repository, candidate)) continue;
      if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
    }
  }
  throw new LocalOperationError(`trusted ${name} executable not found outside the reviewed repository`);
}

function kill(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else if (child.pid !== undefined) {
      const taskkill = spawn(join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true });
      taskkill.once('error', () => child.kill('SIGKILL'));
      taskkill.once('close', (code) => { if (code !== 0) child.kill('SIGKILL'); });
    } else child.kill('SIGKILL');
  } catch { child.kill('SIGKILL'); }
}

export interface LaunchCommand { readonly command: string; readonly prefix: readonly string[] }

/** Resolve npm harness shims without invoking cmd.exe, PowerShell, or a shell. */
export async function hostToolCommand(name: 'pi' | 'opencode' | 'cgc' | 'gitnexus', path: string, repository: string): Promise<LaunchCommand> {
  const packageName = name === 'pi' ? '@earendil-works/pi-coding-agent' : name === 'opencode' ? 'opencode-ai' : name === 'gitnexus' ? 'gitnexus' : undefined;
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory) || inside(repository, directory)) continue;
    const canonicalDirectory = await realpath(directory).catch(() => undefined);
    if (canonicalDirectory === undefined || inside(repository, canonicalDirectory)) continue;
    for (const suffix of process.platform === 'win32' ? ['.exe', '', '.js'] : ['']) {
      const candidate = await realpath(join(directory, name + suffix)).catch(() => undefined);
      if (candidate === undefined || inside(repository, candidate)) continue;
      const handle = await open(candidate, 'r').catch(() => undefined);
      if (handle === undefined) continue;
      let isNode = false;
      try {
        const bytes = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(bytes);
        const line = bytes.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
        isNode = /^#!/u.test(line) && /(?:[/\\\\\s])node(?:\.exe)?(?:\s|$)/iu.test(line);
      } finally { await handle.close(); }
      if (isNode || /\.(?:mjs|cjs|js)$/u.test(candidate)) return { command: process.execPath, prefix: [candidate] };
      if (process.platform !== 'win32' || candidate.toLowerCase().endsWith('.exe')) return { command: candidate, prefix: [] };
    }
    if (packageName === undefined) continue;
    // npm global layouts differ between Unix prefixes and Windows prefixes.
    for (const root of [join(directory, 'node_modules', packageName), resolve(directory, '../lib/node_modules', packageName)]) {
      const canonical = await realpath(root).catch(() => undefined);
      if (canonical === undefined || inside(repository, canonical)) continue;
      const metadataFile = join(canonical, 'package.json');
      const info = await lstat(metadataFile);
      if (!info.isFile() || info.size > 64 * 1024) continue;
      const metadata: unknown = JSON.parse(await readFile(metadataFile, 'utf8'));
      if (typeof metadata !== 'object' || metadata === null || !('bin' in metadata)) continue;
      const bin = metadata.bin;
      const entry = typeof bin === 'string' ? bin : typeof bin === 'object' && bin !== null && name in bin
        ? Reflect.get(bin, name) as unknown : undefined;
      if (typeof entry !== 'string') continue;
      const script = await realpath(resolve(canonical, entry));
      if (!inside(canonical, script) || inside(repository, script)) continue;
      return { command: process.execPath, prefix: [script] };
    }
  }
  throw new LocalOperationError(`trusted ${name} executable not found outside the reviewed repository`);
}

export function harnessCommand(name: 'pi' | 'opencode', path: string, repository: string): Promise<LaunchCommand> {
  return hostToolCommand(name, path, repository);
}

export function cancellableSpawner(signal: AbortSignal, launch?: LaunchCommand): ProcessSpawner {
  return {
    spawn(request) {
      signal.throwIfAborted();
      const child = spawn(request.command, [...(request.command === launch?.command ? launch.prefix : []), ...request.args], {
        cwd: request.cwd, env: process.platform === 'win32' ? {
          ...request.env, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? request.env?.SystemRoot, TEMP: request.cwd, TMP: request.cwd,
        } : request.env, stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', windowsHide: true,
      });
      const abort = (): void => kill(child);
      signal.addEventListener('abort', abort, { once: true });
      const exit = new Promise<{ code: number | null; error?: string }>((resolve) => {
        child.once('error', () => resolve({ code: null, error: 'process launch failed' }));
        child.once('close', (code) => resolve({ code }));
      }).finally(() => signal.removeEventListener('abort', abort));
      child.stdin.on('error', () => undefined);
      child.stdin.end(request.stdin);
      return { stdout: child.stdout, stderr: child.stderr, wait: () => exit, kill: abort };
    },
  };
}

export class GitCommand {
  private readonly command: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly signal: AbortSignal;
  constructor(command: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
    this.command = command; this.cwd = cwd; this.env = env; this.signal = signal;
  }
  async run(args: readonly string[], input?: Buffer, extra: NodeJS.ProcessEnv = {}): Promise<Buffer> {
    this.signal.throwIfAborted();
    const child = spawn(this.command, [
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'diff.external=', '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat',
      ...args,
    ], { cwd: this.cwd, env: { ...this.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const abort = (): void => kill(child);
    this.signal.addEventListener('abort', abort, { once: true });
    let bytes = 0;
    let overflow = false;
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { overflow = true; abort(); } else chunks.push(chunk);
    });
    // Diagnostics are deliberately discarded: Git can echo paths and environment data.
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    const timer = setTimeout(abort, 30_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', () => reject(new Error('Git launch failed')));
        child.once('close', resolve);
      });
      this.signal.throwIfAborted();
      if (overflow) throw new LocalOperationError('Git capture exceeded its byte limit');
      if (code !== 0) throw new LocalOperationError(`Git ${args[0] ?? 'operation'} failed (invalid revision, unsupported state, or capture timeout)`);
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort', abort); }
  }
}
