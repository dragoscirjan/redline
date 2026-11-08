import { execa, execaSync } from 'execa';
import { readFile } from 'node:fs/promises';
import { cancellableSpawner } from '../../src/local/process.ts';
import { runBoundedProcess, type BoundedRunResult, type ProcessSpawner } from '../../src/process-runner.ts';

/** Include descendants that started their own process groups; a CLI's native harness can do that. */
function killFixtureTree(pid: number): void {
  try {
    const snapshot = execaSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
      env: { PATH: process.env.PATH, LC_ALL: 'C' }, extendEnv: false, preferLocal: false, shell: false, verbose: 'none', reject: false,
      timeout: 1000, maxBuffer: 1024 * 1024,
    });
    const rows = snapshot.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number));
    const owned = new Set([pid]);
    for (const [child, , group] of rows) if (group === pid && child !== undefined) owned.add(child);
    for (;;) {
      const previous = owned.size;
      for (const [child, parent] of rows) if (child !== undefined && parent !== undefined && owned.has(parent)) owned.add(child);
      if (owned.size === previous) break;
    }
    for (const child of [...owned].reverse()) if (child !== pid) {
      try { process.kill(child, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* Group already exited. */ }
  }
}

/** Retain the production runner's bounds, adding fixture ownership for detached POSIX descendants. */
function fixtureSpawner(): ProcessSpawner {
  if (process.platform === 'win32') return cancellableSpawner(new AbortController().signal);
  return { spawn(request) {
    const child = execa(request.command, [...request.args], {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }), env: request.env ?? process.env, extendEnv: false, preferLocal: false, shell: false, verbose: 'none',
      detached: true, reject: false, buffer: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = child.then(result => ({ code: result.exitCode ?? null }));
    return { stdout: child.stdout, stderr: child.stderr, wait: () => exit,
      kill: () => { if (child.pid !== undefined) killFixtureTree(child.pid); else child.kill('SIGKILL'); } };
  } };
}

/** Await a bounded fixture process and kill its complete owned process tree before returning on timeout. */
export function runFixtureProcess(command: string, args: readonly string[], options: {
  readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs?: number;
}): Promise<BoundedRunResult> {
  return runBoundedProcess(fixtureSpawner(), {
    command, args, cwd: options.cwd, env: options.env, stdin: '', timeoutMs: options.timeoutMs ?? 70_000,
    stdoutLimitBytes: 256 * 1024,
  });
}

/** Remove only container IDs recorded by this fixture's Docker clients before deleting their mounted temporary state. */
export async function removeFixtureContainers(prefix: string, env: NodeJS.ProcessEnv): Promise<void> {
  for (const harness of ['pi', 'opencode']) {
    const value = await readFile(prefix + '-' + harness, 'utf8').catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (value === undefined) continue;
    const id = value.trim();
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid fixture container ID');
    const result = await execa('docker', ['rm', '--force', id], {
      env, extendEnv: false, preferLocal: false, shell: false, verbose: 'none', reject: false,
      timeout: 10_000, maxBuffer: 32 * 1024,
    });
    if (result.failed && !result.stderr.includes('No such container')) throw new Error('Fixture container cleanup failed; mounted state was preserved');
  }
}
