/** Bounded Git processes with explicit executable paths and no shell. */
import { execa, type Subprocess } from 'execa';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

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
  return value === '' || (value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value));
}

/** Find the worktree boundary without executing a repository-selected binary. */
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

/** Terminate the owned Unix process group or Windows descendants, falling back to the direct child. */
function kill(child: Pick<Subprocess, 'pid' | 'kill'>): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else if (child.pid !== undefined) {
      const taskkill = execa(join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true, reject: false, buffer: false, preferLocal: false, shell: false, verbose: 'none' });
      void taskkill.then(result => { if (result.failed) child.kill('SIGKILL'); });
    } else child.kill('SIGKILL');
  } catch { child.kill('SIGKILL'); }
}

export class GitCommand {
  private readonly command: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly signal: AbortSignal;
  constructor(command: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
    this.command = command; this.cwd = cwd; this.env = env; this.signal = signal;
  }
  /** Return raw Git bytes with hooks and external diff disabled; cancellation, deadline, or overflow kills the tree. */
  async run(args: readonly string[], input?: Buffer, extra: NodeJS.ProcessEnv = {}): Promise<Buffer> {
    this.signal.throwIfAborted();
    const child = execa(this.command, [
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'diff.external=', '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat',
      ...args,
    ], { reject: false, buffer: false, extendEnv: false, preferLocal: false, shell: false, verbose: 'none',
      cwd: this.cwd, env: { ...this.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
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
      const result = await child;
      this.signal.throwIfAborted();
      if (result.failed && result.exitCode === undefined && result.signal === undefined) throw new Error('Git launch failed');
      if (overflow) throw new LocalOperationError('Git capture exceeded its byte limit');
      if (result.exitCode !== 0) throw new LocalOperationError(`Git ${args[0] ?? 'operation'} failed (invalid revision, unsupported state, or capture timeout)`);
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort', abort); }
  }
}
