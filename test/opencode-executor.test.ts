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
  readonly requests: Array<{ command: string; args: string[]; stdin?: string | undefined;
    env?: Record<string, string | undefined> | undefined }> = [];
  #stdout = '';
  #code: number | null = 0;
  #waitMs = 0;

  script(stdout: string, code: number | null): void {
    this.#stdout = stdout;
    this.#code = code;
  }

  scriptWait(milliseconds: number): void {
    this.#waitMs = milliseconds;
  }

  spawn(request: { command: string; args: readonly string[]; stdin?: string | undefined;
    env?: Record<string, string | undefined> | undefined }): SpawnedProcess {
    this.requests.push({ command: request.command, args: [...request.args], stdin: request.stdin, env: request.env });
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
      wait: async () => {
        if (this.#waitMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#waitMs));
        return { code: this.#code };
      },
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

      const request = spawner.requests[0]!;
      const configFile = request.env?.OPENCODE_CONFIG;
      expect(configFile).toBeDefined();
      const config = JSON.parse(await readFile(configFile!, 'utf8'));
      expect(config.provider.mock.options.baseURL).toBe('http://127.0.0.1:8787/v1');
      expect(config.provider.mock.options.apiKey).toBe('test-key');
      expect(config.provider.mock.models['test-model']).toEqual({});
      expect(config.agent[OPENCODE_REVIEW_AGENT].prompt).toBe('POLICY-SYSTEM');
      expect(config.agent[OPENCODE_REVIEW_AGENT].tools).toMatchObject({ bash: false, read: false, skill: false });

      // The credential-bearing config file is mode 0600.
      const info = await stat(configFile!);
      expect(info.mode & 0o777).toBe(0o600);

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
      ]);
      expect(request.stdin).toBe('USER');
      expect(request.env?.OPENCODE_CONFIG).toBe(configFile);
      expect(request.env?.XDG_CONFIG_HOME).toContain(join('opencode', 'invocation-'));
      expect(request.env?.XDG_DATA_HOME).toContain(join('opencode', 'invocation-'));
      expect(request.env?.XDG_STATE_HOME).toContain(join('opencode', 'invocation-'));
      expect(request.env?.HOME).toContain(join('opencode', 'invocation-'));
      // No ambient credentials leak into the child environment.
      expect(Object.keys(request.env ?? {}).sort()).toEqual(
        ['HOME', 'LANG', 'OPENCODE_CONFIG', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].sort(),
      );
      expect(prepared.description).not.toContain('test-key');
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });

  it('isolates configuration and home directories across concurrent invocations', async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'redline-oc-'));
    try {
      const spawner = new RecordingSpawner();
      const executor = createOpenCodeExecutor({ command: 'opencode-fake', spawner });
      const prepared = await executor.prepare({ ...SETTINGS, workDirectory });
      await Promise.all([
        executor.execute(prepared, { system: 'SYSTEM-A', user: 'USER-A' }),
        executor.execute(prepared, { system: 'SYSTEM-B', user: 'USER-B' }),
      ]);

      const [first, second] = spawner.requests;
      expect(first?.env?.OPENCODE_CONFIG).toBeDefined();
      expect(second?.env?.OPENCODE_CONFIG).toBeDefined();
      expect(first?.env?.OPENCODE_CONFIG).not.toBe(second?.env?.OPENCODE_CONFIG);
      expect(first?.env?.HOME).not.toBe(second?.env?.HOME);
      const firstConfig = JSON.parse(await readFile(first!.env!.OPENCODE_CONFIG!, 'utf8'));
      const secondConfig = JSON.parse(await readFile(second!.env!.OPENCODE_CONFIG!, 'utf8'));
      expect(firstConfig.agent[OPENCODE_REVIEW_AGENT].prompt).toBe('SYSTEM-A');
      expect(secondConfig.agent[OPENCODE_REVIEW_AGENT].prompt).toBe('SYSTEM-B');
      expect(first?.stdin).toBe('USER-A');
      expect(second?.stdin).toBe('USER-B');
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });

  it('uses a positive per-invocation timeout before the prepared default', async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'redline-oc-'));
    try {
      const spawner = new RecordingSpawner();
      const executor = createOpenCodeExecutor({ command: 'opencode-fake', spawner });
      const prepared = await executor.prepare({ ...SETTINGS, workDirectory });
      const prompt = { system: 'fixed policy', user: 'review' };
      spawner.scriptWait(80);
      expect((await executor.execute(prepared, prompt, { timeoutMs: 20 })).status).toBe('timed-out');
      expect((await executor.execute(prepared, prompt)).status).not.toBe('timed-out');
      await expect(executor.execute(prepared, prompt, { timeoutMs: 0 })).rejects.toThrow(/process timeout is invalid/u);
      expect(spawner.requests).toHaveLength(2);
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });

  it('keeps a 256 KiB untrusted review prompt out of the process argument list', async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'redline-oc-'));
    try {
      const spawner = new RecordingSpawner();
      const executor = createOpenCodeExecutor({ command: 'opencode-fake', spawner });
      const prepared = await executor.prepare({ ...SETTINGS, workDirectory });
      const context = 'x'.repeat(256 * 1024);
      await executor.execute(prepared, { system: 'fixed policy', user: context });
      expect(spawner.requests[0]?.stdin).toBe(context);
      expect(spawner.requests[0]?.args.every((value) => value.length < 4_096)).toBe(true);
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });

  it('omits the api key when no credential is configured', async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'redline-oc-'));
    try {
      const spawner = new RecordingSpawner();
      const executor = createOpenCodeExecutor({ spawner });
      const prepared = await executor.prepare({ ...SETTINGS, workDirectory, credential: undefined });
      await executor.execute(prepared, { system: 'S', user: 'U' });
      const configFile = spawner.requests[0]?.env?.OPENCODE_CONFIG;
      expect(configFile).toBeDefined();
      const config = JSON.parse(await readFile(configFile!, 'utf8'));
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

  it('records bounded output and first-text telemetry', async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'redline-oc-'));
    try {
      const spawner = new RecordingSpawner();
      const executor = createOpenCodeExecutor({ command: 'opencode-fake', spawner });
      const prepared = await executor.prepare({ ...SETTINGS, workDirectory });
      const stdout = `${JSON.stringify({ type: 'text', part: { type: 'text', text: 'RESULT' } })}\n`;
      spawner.script(stdout, 0);
      const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' });

      expect(run.status).toBe('succeeded');
      expect(run.telemetry).toMatchObject({
        processStartupMs: expect.any(Number),
        timeToFirstTextMs: expect.any(Number),
        stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });
});
