import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createOpenCodeExecutor,
  extractOpenCodeAssistantText,
  OPENCODE_REVIEW_AGENT,
} from '../src/harness-executor/opencode-executor.js';
import type { ProcessSpawner, SpawnedProcess } from '../src/harness-executor/process-runner.js';
import type { HarnessSettings } from '../src/harness-executor/types.js';

const SETTINGS: HarnessSettings = {
  model: { provider: 'mock', endpoint: 'http://127.0.0.1:8787/v1', model: 'test-model' },
  credential: { provider: 'mock', value: 'test-key' },
  timeoutMs: 1_000,
  workDirectory: '',
};

class RecordingSpawner implements ProcessSpawner {
  readonly requests: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> | undefined }> = [];
  #stdout = '';
  #code: number | null = 0;

  script(stdout: string, code: number | null): void {
    this.#stdout = stdout;
    this.#code = code;
  }

  spawn(request: { command: string; args: readonly string[]; env?: Record<string, string | undefined> | undefined }): SpawnedProcess {
    this.requests.push({ command: request.command, args: [...request.args], env: request.env });
    const encoder = new TextEncoder();
    const stdout = encoder.encode(this.#stdout);
    const empty = encoder.encode('');
    return {
      stdout: (async function* () {
        yield stdout;
      })(),
      stderr: (async function* () {
        yield empty;
      })(),
      wait: async () => ({ code: this.#code }),
      kill: () => undefined,
    };
  }
}

describe('createOpenCodeExecutor', () => {
  it('generates an isolated config with the review agent and disabled tools', async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'redline-oc-'));
    try {
      const spawner = new RecordingSpawner();
      const executor = createOpenCodeExecutor({ command: 'opencode-fake', spawner });
      const prepared = await executor.prepare({ ...SETTINGS, workDirectory });
      spawner.script('', 0);
      await executor.execute(prepared, { system: 'POLICY-SYSTEM', user: 'USER' });

      const configFile = join(workDirectory, 'opencode', 'config', 'opencode.json');
      const config = JSON.parse(await readFile(configFile, 'utf8'));
      expect(config.provider.mock.options.baseURL).toBe('http://127.0.0.1:8787/v1');
      expect(config.provider.mock.options.apiKey).toBe('test-key');
      expect(config.provider.mock.models['test-model']).toEqual({});
      expect(config.agent[OPENCODE_REVIEW_AGENT].prompt).toBe('POLICY-SYSTEM');
      expect(config.agent[OPENCODE_REVIEW_AGENT].tools).toMatchObject({ bash: false, read: false, skill: false });

      // The credential-bearing config file is mode 0600.
      const info = await stat(configFile);
      expect(info.mode & 0o777).toBe(0o600);

      const request = spawner.requests[0]!;
      expect(request.command).toBe('opencode-fake');
      expect(request.args).toEqual([
        'run',
        '--pure',
        '--format',
        'json',
        '--agent',
        OPENCODE_REVIEW_AGENT,
        '--title',
        'redline-review',
        '--model',
        'mock/test-model',
        '--',
        'USER',
      ]);
      expect(request.env?.OPENCODE_CONFIG).toBe(configFile);
      expect(request.env?.XDG_CONFIG_HOME).toContain(join('opencode', 'config'));
      expect(request.env?.XDG_DATA_HOME).toContain(join('opencode', 'data'));
      expect(request.env?.XDG_STATE_HOME).toContain(join('opencode', 'state'));
      expect(request.env?.HOME).toContain(join('opencode', 'home'));
      // No ambient credentials leak into the child environment.
      expect(Object.keys(request.env ?? {}).sort()).toEqual(
        ['HOME', 'LANG', 'OPENCODE_CONFIG', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].sort(),
      );
      expect(prepared.description).not.toContain('test-key');
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });

  it('omits the api key when no credential is configured', async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'redline-oc-'));
    try {
      const executor = createOpenCodeExecutor({ spawner: new RecordingSpawner() });
      const prepared = await executor.prepare({ ...SETTINGS, workDirectory, credential: undefined });
      await executor.execute(prepared, { system: 'S', user: 'U' });
      const config = JSON.parse(await readFile(join(workDirectory, 'opencode', 'config', 'opencode.json'), 'utf8'));
      expect(config.provider.mock.options).toEqual({ baseURL: 'http://127.0.0.1:8787/v1' });
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });
});

describe('extractOpenCodeAssistantText', () => {
  it('concatenates text parts from the event stream', () => {
    const stdout = [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'HELLO ' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'WORLD' } }),
    ].join('\n');
    expect(extractOpenCodeAssistantText(stdout)).toBe('HELLO WORLD');
  });

  it('returns undefined without text parts', () => {
    expect(extractOpenCodeAssistantText('{"type":"step_start"}\n')).toBeUndefined();
  });
});
