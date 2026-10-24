import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionFollowUpExecutor } from '../src/action/follow-up.ts';
import { FollowUpBudget } from '../src/code-context/follow-up.ts';
import type { ProcessSpawner, SpawnRequest, SpawnedProcess } from '../src/process-runner.ts';

function plan() {
  const candidateId = `f-${'1'.repeat(24)}`;
  return new FollowUpBudget().plan({ repository: 'owner/repo', base: 'a'.repeat(40), head: 'b'.repeat(40) },
    '000001', 'src/example.ts', [candidateId], [{ candidateId, direction: 'incoming' }]);
}

class ResultSpawner implements ProcessSpawner {
  readonly #mode: 'missing' | 'empty' | 'oversized';

  constructor(mode: 'missing' | 'empty' | 'oversized') {
    this.#mode = mode;
  }

  spawn(request: SpawnRequest): SpawnedProcess {
    const path = request.args[request.args.indexOf('--output') + 1];
    if (path === undefined) throw new Error('missing worker output path');
    if (this.#mode !== 'missing') writeFileSync(path, this.#mode === 'empty' ? '' : 'x'.repeat(256 * 1024 + 1));
    return {
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      kill: () => undefined,
    };
  }
}

describe('action-owned worker result bounds', () => {
  it.each([
    ['missing', 'follow-up result is missing or empty'],
    ['empty', 'follow-up result is missing or empty'],
    ['oversized', 'follow-up result exceeded its size limit'],
  ] as const)('reports %s output accurately', async (mode, message) => {
    const root = await mkdtemp(join(tmpdir(), 'redline-action-follow-up-'));
    try {
      const executor = createActionFollowUpExecutor({
        provider: 'cgc', runnerTemp: root, reviewDirectory: root,
        actionRoot: resolve('.'), spawner: new ResultSpawner(mode),
      });
      await expect(executor(plan())).rejects.toThrow(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
