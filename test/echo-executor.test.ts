import { describe, expect, it } from 'vitest';
import { EchoHarnessExecutor } from '../src/harness-executor/echo-executor.js';
import type { HarnessSettings } from '../src/harness-executor/types.js';

const SETTINGS: HarnessSettings = {
  model: { provider: 'mock', endpoint: 'http://127.0.0.1:8787/v1', model: 'test-model' },
  credential: { provider: 'mock', value: 'test-key' },
  timeoutMs: 1_000,
  workDirectory: '/tmp',
};

describe('EchoHarnessExecutor', () => {
  it('returns a deterministic clean review for the prompted file', async () => {
    const executor = new EchoHarnessExecutor();
    const prepared = await executor.prepare(SETTINGS);
    expect(prepared.harness).toBe('echo');
    expect(prepared.description).not.toContain('test-key');

    const run = await executor.execute(prepared, {
      system: 'policy',
      user: 'review {"fileId": "000042"} more',
    });
    expect(run.status).toBe('succeeded');
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.text)).toEqual({ version: 1, fileId: '000042', outcome: 'clean', findings: [] });
  });

  it('falls back to a zero file id when the prompt carries none', async () => {
    const executor = new EchoHarnessExecutor();
    const prepared = await executor.prepare(SETTINGS);
    const run = await executor.execute(prepared, { system: '', user: 'no manifest here' });
    expect(JSON.parse(run.text)).toEqual({ version: 1, fileId: '000000', outcome: 'clean', findings: [] });
  });
});
