import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPiExecutor, extractPiAssistantText, PI_CREDENTIAL_ENV_NAME } from '../src/harness-executor/pi-executor.js';
import type { ProcessSpawner, SpawnedProcess } from '../src/harness-executor/process-runner.js';
import type { HarnessSettings } from '../src/harness-executor/types.js';

/** Settings with a caller-managed scratch directory; `prepare` writes inside it. */
async function createSettings(
  overrides: Partial<HarnessSettings> = {},
): Promise<HarnessSettings & { cleanup: () => Promise<void> }> {
  const workDirectory = await mkdtemp(join(tmpdir(), 'redline-pi-settings-'));
  return {
    model: { provider: 'mock', endpoint: 'http://127.0.0.1:8787/v1', model: 'test-model' },
    credential: { provider: 'mock', value: 'test-key' },
    timeoutMs: 1_000,
    workDirectory,
    ...overrides,
    cleanup: () => rm(workDirectory, { recursive: true, force: true }),
  };
}

/** Spawner double that records the spawn request and returns scripted output. */
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

describe('createPiExecutor', () => {
  it('generates models.json without embedding the credential and sets the agent dir env', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      spawner.script('{"type":"session"}\n', 0);
      await executor.execute(prepared, { system: 'SYS', user: 'USER' });

      const modelsJson = JSON.parse(await readFile(join(settings.workDirectory, 'pi-agent', 'models.json'), 'utf8'));
      expect(modelsJson.providers.mock.baseUrl).toBe('http://127.0.0.1:8787/v1');
      expect(modelsJson.providers.mock.api).toBe('openai-completions');
      expect(modelsJson.providers.mock.apiKey).toBe(`$${PI_CREDENTIAL_ENV_NAME}`);
      expect(modelsJson.providers.mock.models).toEqual([{ id: 'test-model' }]);

      const request = spawner.requests[0]!;
      expect(request.command).toBe('pi-fake');
      expect(request.args).toEqual([
        '--print',
        '--mode',
        'json',
        '--no-session',
        '--no-tools',
        '--provider',
        'mock',
        '--model',
        'test-model',
        '--system-prompt',
        'SYS',
        '--',
        'USER',
      ]);
      expect(request.env?.PI_CODING_AGENT_DIR).toContain('pi-agent');
      expect(request.env?.[PI_CREDENTIAL_ENV_NAME]).toBe('test-key');
      // No ambient credentials leak into the child environment.
      expect(Object.keys(request.env ?? {}).sort()).toEqual(
        ['HOME', 'LANG', 'PATH', 'PI_CODING_AGENT_DIR', PI_CREDENTIAL_ENV_NAME].sort(),
      );
    } finally {
      await settings.cleanup();
    }
  });

  it('uses an unauthenticated placeholder when no credential is configured', async () => {
    const settings = await createSettings({ credential: undefined });
    try {
      const executor = createPiExecutor({ spawner: new RecordingSpawner() });
      const prepared = await executor.prepare(settings);
      const modelsJson = JSON.parse(await readFile(join(settings.workDirectory, 'pi-agent', 'models.json'), 'utf8'));
      expect(modelsJson.providers.mock.apiKey).toBe('redline-unauthenticated');
      expect(prepared.description).not.toContain('test-key');
    } finally {
      await settings.cleanup();
    }
  });

  it('reports failure when pi produces no turn_end assistant text', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ spawner });
      const prepared = await executor.prepare(settings);
      spawner.script('{"type":"session"}\n', 0);
      const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' });
      expect(run.status).toBe('failed');
      expect(run.text).toBe('');
    } finally {
      await settings.cleanup();
    }
  });
});

describe('extractPiAssistantText', () => {
  it('extracts the text of the final turn_end message', () => {
    const stdout = [
      JSON.stringify({ type: 'session', id: 's' }),
      JSON.stringify({
        type: 'turn_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'PART-A ' }] },
      }),
      JSON.stringify({
        type: 'turn_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'PART-B' }] },
      }),
    ].join('\n');
    expect(extractPiAssistantText(stdout)).toBe('PART-B');
  });

  it('returns undefined when no turn_end event exists', () => {
    expect(extractPiAssistantText('{"type":"session"}\n')).toBeUndefined();
    expect(extractPiAssistantText('')).toBeUndefined();
  });

  it('forwards heartbeat event boundaries, never event content', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const stdout = [
        '{"type":"session"}',
        '{"type":"message_update","assistantMessageEvent":{"content":"untrusted quoted content"}}',
        '{"type":"message_end"}',
        '{"type":"turn_end"}',
        '{"type":"agent_end"}',
        '',
      ].join('\n');
      spawner.script(stdout, 0);
      const tapped: string[] = [];
      await executor.execute(prepared, { system: 'SYS', user: 'USER' }, {
        onOutputLine: (output) => tapped.push(`${output.stream}:${output.line}`),
      });

      // Only event boundaries pass through; the message_update content —
      // which can quote pull request data — is dropped, as is the session
      // noise.
      expect(tapped).toEqual([
        'stdout:pi event: message_end',
        'stdout:pi event: turn_end',
        'stdout:pi event: agent_end',
      ]);
    } finally {
      await settings.cleanup();
    }
  });
});
