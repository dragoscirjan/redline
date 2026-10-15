import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { FollowUpRequestBatch } from '../code-context/follow-up.js';
import { nodeProcessSpawner, runBoundedProcess, type ProcessSpawner } from '../process-runner.js';

const WORKER_TIMEOUT_MS = 120_000;
const MAX_RESULT_BYTES = 256 * 1024;

export interface ActionFollowUpConfig {
  readonly provider: 'cgc' | 'gitnexus';
  readonly runnerTemp: string;
  readonly reviewDirectory: string;
  readonly actionRoot: string;
  readonly spawner?: ProcessSpawner;
}

/** Action-only adapter: no provider binaries, graph queries or caches enter review-domain code. */
export function createActionFollowUpExecutor(config: ActionFollowUpConfig):
  (batch: FollowUpRequestBatch, remainingMs?: number) => Promise<string> {
  if (!['cgc', 'gitnexus'].includes(config.provider) ||
      ![config.runnerTemp, config.reviewDirectory, config.actionRoot].every(isAbsolute)) {
    throw new Error('follow-up requires trusted absolute action paths and a pinned provider');
  }
  return async (batch, remainingMs = WORKER_TIMEOUT_MS) => {
    if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
      throw new Error('cumulative follow-up time budget exhausted');
    }
    const directory = await mkdtemp(join(config.runnerTemp, 'redline-follow-up-'));
    try {
      const input = join(directory, 'request.json');
      const output = join(directory, 'result.json');
      await writeFile(input, JSON.stringify(batch), { mode: 0o600 });
      const result = await runBoundedProcess(config.spawner ?? nodeProcessSpawner, {
        command: 'python3',
        args: [join(config.actionRoot, 'github/code-index/follow-up.py'),
          '--provider', config.provider,
          '--repository', batch.repository,
          '--base', batch.base, '--head', batch.head,
          '--review-dir', config.reviewDirectory,
          '--runner-temp', config.runnerTemp,
          '--input', input, '--output', output],
        cwd: config.actionRoot,
        // The hosted runner supplies trusted Python on PATH. Do not forward
        // model auth, publication tokens, or any REDLINE_* variables.
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
          RUNNER_TEMP: config.runnerTemp },
        timeoutMs: Math.min(WORKER_TIMEOUT_MS, remainingMs),
      });
      if (result.timedOut || result.code !== 0) {
        throw new Error(result.timedOut ? 'action-owned follow-up timed out' : 'action-owned follow-up unavailable');
      }
      const info = await stat(output);
      if (info.size > MAX_RESULT_BYTES || info.size === 0) throw new Error('follow-up result exceeded its size limit');
      return await readFile(output, 'utf8');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
