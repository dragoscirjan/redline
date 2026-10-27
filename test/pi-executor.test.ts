import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createPiExecutor,
  extractPiAssistantText,
  inspectPiAssistantOutput,
  PI_CREDENTIAL_ENV_NAME,
} from '../src/harness-executor/pi-executor.ts';
import { MAX_OUTPUT_BYTES, type ProcessSpawner, type SpawnedProcess } from '../src/harness-executor/process-runner.ts';
import type { HarnessSettings } from '../src/harness-executor/types.ts';

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
interface ScriptedProcess {
  readonly stdout: string;
  readonly code: number | null;
  readonly stderr?: string | undefined;
}

class SequenceSpawner implements ProcessSpawner {
  readonly requests: Array<{ command: string; args: string[]; stdin?: string | undefined;
    env?: Record<string, string | undefined> | undefined }> = [];
  readonly #scripts: ScriptedProcess[];

  constructor(scripts: readonly ScriptedProcess[]) {
    this.#scripts = [...scripts];
  }

  spawn(request: { command: string; args: readonly string[]; stdin?: string | undefined;
    env?: Record<string, string | undefined> | undefined }): SpawnedProcess {
    this.requests.push({ command: request.command, args: [...request.args], stdin: request.stdin, env: request.env });
    const script = this.#scripts.shift();
    if (script === undefined) throw new Error('sequence spawner ran out of scripts');
    const encoder = new TextEncoder();
    const stdout = encoder.encode(script.stdout);
    const stderr = encoder.encode(script.stderr ?? '');
    return {
      stdout: (async function* () { yield stdout; })(),
      stderr: (async function* () { yield stderr; })(),
      wait: async () => ({ code: script.code }),
      kill: () => undefined,
    };
  }
}

class RecordingSpawner implements ProcessSpawner {
  readonly requests: Array<{ command: string; args: string[]; stdin?: string | undefined;
    env?: Record<string, string | undefined> | undefined }> = [];
  #stdout = '';
  #stderr = '';
  #code: number | null = 0;
  #waitMs = 0;

  script(stdout: string, code: number | null, stderr = ''): void {
    this.#stdout = stdout;
    this.#stderr = stderr;
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
    const stderr = encoder.encode(this.#stderr);
    return {
      stdout: (async function* () {
        yield stdout;
      })(),
      stderr: (async function* () {
        yield stderr;
      })(),
      wait: async () => {
        if (this.#waitMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#waitMs));
        return { code: this.#code };
      },
      kill: () => undefined,
    };
  }
}

describe('createPiExecutor', () => {
  it('retains the final answer after a 32k-token invocation emits more than eight MiB of NDJSON', async () => {
    const settings = await createSettings({ maxOutputTokens: 32768, timeoutMs: 10_000 });
    try {
      const update = `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'x'.repeat(512) } })}\n`;
      const final = JSON.stringify({ version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [] });
      const stdout = update.repeat(Math.ceil((9 * 1024 * 1024) / Buffer.byteLength(update)))
        + `${JSON.stringify({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: final }], stopReason: 'stop' } })}\n`;
      const spawner = new SequenceSpawner([{ stdout, code: 0 }]);
      const executor = createPiExecutor({ spawner });
      const prepared = await executor.prepare(settings);
      const run = await executor.execute(prepared, { system: 'policy', user: 'fixture' }, { streamMode: 'off' });
      expect(run.status).toBe('succeeded'); expect(run.text).toBe(final);
      expect(run.telemetry?.stdoutBytes).toBeGreaterThan(MAX_OUTPUT_BYTES);
      expect(run.telemetry?.stdoutTruncated).toBe(false);
    } finally { await settings.cleanup(); }
  });
  it('uses the trusted per-call output-token setting above the old fixed ceiling', async () => {
    const settings = await createSettings({ maxOutputTokens: 65536 });
    try {
      const prepared = await createPiExecutor().prepare(settings);
      expect(JSON.parse((prepared as import('../src/harness-executor/pi-executor.ts').PreparedPi).agentConfig).providers.mock.models[0].maxTokens).toBe(65536);
      expect(prepared.description).toContain('max-output-tokens=65536');
    } finally { await settings.cleanup(); }
  });
  it('generates models.json without embedding the credential and sets the agent dir env', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      spawner.script('{"type":"session"}\n', 0);
      await executor.execute(prepared, { system: 'SYS', user: 'USER' });

      const request = spawner.requests[0]!;
      const agentDirectory = request.env?.PI_CODING_AGENT_DIR;
      expect(agentDirectory).toBeDefined();
      const modelsJson = JSON.parse(await readFile(join(agentDirectory!, 'models.json'), 'utf8'));
      expect(modelsJson.providers.mock.baseUrl).toBe('http://127.0.0.1:8787/v1');
      expect(modelsJson.providers.mock.api).toBe('openai-completions');
      expect(modelsJson.providers.mock.apiKey).toBe(`$${PI_CREDENTIAL_ENV_NAME}`);
      expect(modelsJson.providers.mock.models).toEqual([{
        id: 'test-model', reasoning: false, maxTokens: 16_384,
      }]);
      expect(JSON.parse(await readFile(join(agentDirectory!, 'settings.json'), 'utf8'))).toEqual({
        defaultThinkingLevel: 'off',
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      });

      expect(request.command).toBe('pi-fake');
      expect(request.args.slice(0, -1)).toEqual([
        '--print',
        '--mode',
        'json',
        '--no-session',
        '--no-tools',
        '--thinking',
        'off',
        '--provider',
        'mock',
        '--model',
        'test-model',
        '--system-prompt',
      ]);
      const systemPromptFile = request.args.at(-1)!;
      expect(systemPromptFile).toBe(join(agentDirectory!, 'system-prompt.md'));
      expect(request.stdin).toBe('USER');
      expect(await readFile(systemPromptFile, 'utf8')).toBe('SYS');
      expect((await stat(systemPromptFile)).mode & 0o777).toBe(0o600);
      expect(request.env?.PI_CODING_AGENT_DIR).toContain(join('pi-agent', 'invocation-'));
      expect(request.env?.[PI_CREDENTIAL_ENV_NAME]).toBe('test-key');
      // No ambient credentials leak into the child environment.
      expect(Object.keys(request.env ?? {}).sort()).toEqual(
        ['HOME', 'LANG', 'PATH', 'PI_CODING_AGENT_DIR', 'PI_SKIP_VERSION_CHECK', PI_CREDENTIAL_ENV_NAME].sort(),
      );
    } finally {
      await settings.cleanup();
    }
  });

  it('writes explicit OpenRouter request controls and caller-owned strict schema without enabling tools', async () => {
    const settings = await createSettings({ model: { provider: 'openrouter', endpoint: 'http://127.0.0.1:8787/v1', model: 'test-model' }, credential: undefined, modelProtocol: 'openrouter-json' });
    try {
      const spawner = new RecordingSpawner(); const executor = createPiExecutor({ spawner, transientRetries: 0 });
      const prepared = await executor.prepare(settings); spawner.script('{"type":"session"}\n', 0);
      const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
      await executor.execute(prepared, { system: 'SYS', user: 'USER', responseSchema: schema });
      const request = spawner.requests[0]!;
      const config = JSON.parse(await readFile(join(request.env!.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'));
      expect(config.providers.openrouter.models[0].samplingParams).toEqual({
        reasoning: { enabled: false }, provider: { require_parameters: true },
        response_format: { type: 'json_schema', json_schema: { name: 'redline_file_review', strict: true, schema } },
      });
      expect(request.args).toContain('--no-tools'); expect(request.args).toContain('off');
    } finally { await settings.cleanup(); }
  });

  it('uses benchmark-only thinking, output, and structured-output overrides without changing isolation', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({
        command: 'pi-fake',
        spawner,
        thinkingLevel: 'low',
        maxOutputTokens: 8_192,
        temperature: 0,
        structuredOutput: 'json-object',
        transientRetries: 0,
      });
      const prepared = await executor.prepare(settings);
      spawner.script('{"type":"session"}\n', 0);
      await executor.execute(prepared, { system: 'SYS', user: 'USER' });

      const request = spawner.requests[0]!;
      expect(request.args).toContain('low');
      const modelsJson = JSON.parse(await readFile(join(request.env!.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'));
      expect(modelsJson.providers.mock.models).toEqual([{
        id: 'test-model',
        reasoning: true,
        maxTokens: 8_192,
        samplingParams: { temperature: 0, response_format: { type: 'json_object' } },
      }]);
    } finally {
      await settings.cleanup();
    }
  });

  it('retries one classified transient empty provider response in a fresh invocation', async () => {
    const settings = await createSettings();
    try {
      const empty = '{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"stop","usage":{"input":3,"output":0}}}\n';
      const complete = '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"complete"}],"stopReason":"stop","usage":{"input":3,"output":1}}}\n';
      const spawner = new SequenceSpawner([
        { stdout: empty, code: 0 },
        { stdout: complete, code: 0 },
        { stdout: complete, code: 0 },
      ]);
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' });

      expect(run.status).toBe('succeeded');
      expect(run.text).toBe('complete');
      expect(run.telemetry?.retryCount).toBe(1);
      expect(run.telemetry?.usage).toMatchObject({
        inputTokens: 6,
        outputTokens: 1,
        totalTokens: 7,
      });
      expect(spawner.requests).toHaveLength(2);
      expect(spawner.requests[0]?.env?.PI_CODING_AGENT_DIR).not.toBe(
        spawner.requests[1]?.env?.PI_CODING_AGENT_DIR,
      );
    } finally {
      await settings.cleanup();
    }
  });

  it('retries one allowlisted transient provider transport failure', async () => {
    const settings = await createSettings();
    try {
      const complete = '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"complete"}],"stopReason":"stop","usage":{"input":3,"output":1}}}\n';
      const spawner = new SequenceSpawner([
        { stdout: '', code: 1, stderr: 'provider returned HTTP 503' },
        { stdout: complete, code: 0 },
      ]);
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' });

      expect(run.status).toBe('succeeded');
      expect(run.telemetry?.retryCount).toBe(1);
      expect(spawner.requests).toHaveLength(2);
    } finally {
      await settings.cleanup();
    }
  });

  it('caps repeated transient empty provider output at one retry', async () => {
    const settings = await createSettings();
    try {
      const empty = '{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"stop","usage":{"input":3,"output":0}}}\n';
      const spawner = new SequenceSpawner([
        { stdout: empty, code: 0 },
        { stdout: empty, code: 0 },
        { stdout: empty, code: 0 },
      ]);
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' });

      expect(run.status).toBe('failed');
      expect(run.telemetry?.retryCount).toBe(1);
      expect(spawner.requests).toHaveLength(2);
    } finally {
      await settings.cleanup();
    }
  });

  it('does not retry deterministic output-budget exhaustion', async () => {
    const settings = await createSettings();
    try {
      const spawner = new SequenceSpawner([{
        stdout: '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private"}],"stopReason":"length","usage":{"output":4096}}}\n',
        code: 0,
      }]);
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' });

      expect(run.status).toBe('failed');
      expect(run.diagnostic).toContain('model-output-budget-exhausted');
      expect(run.telemetry?.retryCount).toBe(0);
      expect(spawner.requests).toHaveLength(1);
    } finally {
      await settings.cleanup();
    }
  });

  it.each([
    [401, 'Invalid API key', 'run'],
    [402, 'Insufficient credits', 'run'],
    [404, 'Model not found', 'run'],
    [400, 'Invalid JSON schema for response_format', 'run'],
    [422, 'Unsupported parameter: reasoning', 'run'],
    [400, 'Context length exceeded', 'file'],
    [403, 'Content moderation refusal', 'file'],
    [0, 'Unexpected SDK failure', 'file'],
    [0, 'Invalid JSON schema for response_format', 'run'],
  ] as const)('preserves a redacted Pi error without retrying: %s %s', async (status, message, scope) => {
    const settings = await createSettings();
    try {
      const stdout = JSON.stringify({ type: 'turn_end', message: {
        role: 'assistant', stopReason: 'error', content: [], usage: { input: 0, output: 0 },
        errorMessage: `${status || ''} ${message}; test-key`,
        privatePayload: 'PRIVATE_PROMPT_MARKER',
      } }) + '\n';
      const spawner = new SequenceSpawner([{ stdout, code: 0 }]);
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const run = await executor.execute(await executor.prepare(settings), { system: 'SYS', user: 'USER' });
      expect(run.status).toBe('failed');
      expect(run.failureScope).toBe(scope);
      expect(run.telemetry?.retryCount).toBe(0);
      expect(spawner.requests).toHaveLength(1);
      expect(JSON.parse(run.diagnostic)).toMatchObject({ schema: 'pi-error/v1', scope, message: expect.stringContaining(message) });
      expect(run.diagnostic).toContain('[redacted]');
      expect(run.diagnostic).not.toMatch(/test-key|PRIVATE_PROMPT_MARKER/u);
      expect(run.diagnostic.length).toBeLessThanOrEqual(500);
    } finally { await settings.cleanup(); }
  });

  it.each([429, 503])('retries one explicit exit-zero Pi HTTP %s error', async (status) => {
    const settings = await createSettings();
    try {
      const spawner = new SequenceSpawner([
        { stdout: JSON.stringify({ type: 'turn_end', message: { role: 'assistant', stopReason: 'error', content: [], errorMessage: `HTTP ${status}: provider unavailable` } }) + '\n', code: 0 },
        { stdout: '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"complete"}],"stopReason":"stop"}}\n', code: 0 },
      ]);
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const run = await executor.execute(await executor.prepare(settings), { system: 'SYS', user: 'USER' });
      expect(run.status).toBe('succeeded'); expect(run.telemetry?.retryCount).toBe(1);
      expect(spawner.requests).toHaveLength(2);
    } finally { await settings.cleanup(); }
  });

  it('keeps long escaped SDK errors valid, bounded, redacted and separate from prompts', async () => {
    const settings = await createSettings({ credential: { provider: 'mock', value: 'secret"key' } });
    try {
      const stdout = JSON.stringify({ type: 'turn_end', message: {
        role: 'assistant', stopReason: 'error', content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }],
        errorMessage: '401 Invalid API key secret"key ' + JSON.stringify({ key: 'secret"key' }) + ' ' + encodeURIComponent('secret"key') + '\\'.repeat(1000),
      } }) + '\n';
      const spawner = new SequenceSpawner([{ stdout, code: 0 }]);
      const executor = createPiExecutor({ spawner });
      const run = await executor.execute(await executor.prepare(settings), { system: 'PRIVATE_SYSTEM', user: 'PRIVATE_SOURCE' });
      expect(JSON.parse(run.diagnostic).message).toContain('[redacted]');
      expect(run.diagnostic.length).toBeLessThanOrEqual(500);
      expect(run.diagnostic).not.toMatch(/PRIVATE_|secret/u);
    } finally { await settings.cleanup(); }
  });

  it('rejects partial assistant text when the runtime ended in error', async () => {
    const settings = await createSettings();
    try {
      const stdout = JSON.stringify({ type: 'turn_end', message: { role: 'assistant', stopReason: 'error',
        content: [{ type: 'text', text: 'PRIVATE_PARTIAL_RESPONSE' }], errorMessage: '400 Invalid JSON schema' } }) + '\n';
      const spawner = new SequenceSpawner([{ stdout, code: 0 }]);
      const executor = createPiExecutor({ spawner });
      const run = await executor.execute(await executor.prepare(settings), { system: 'SYS', user: 'USER' });
      expect(run.status).toBe('failed'); expect(run.text).toBe('');
      expect(run.diagnostic).not.toContain('PRIVATE_PARTIAL_RESPONSE');
      expect(run.failureScope).toBe('run');
    } finally { await settings.cleanup(); }
  });

  it('does not retry a Pi error with no error message', async () => {
    const settings = await createSettings();
    try {
      const spawner = new SequenceSpawner([{ stdout: '{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"error","usage":{"output":0}}}\n', code: 0 }]);
      const executor = createPiExecutor({ spawner });
      const run = await executor.execute(await executor.prepare(settings), { system: 'SYS', user: 'USER' });
      expect(run.status).toBe('failed'); expect(run.telemetry?.retryCount).toBe(0); expect(spawner.requests).toHaveLength(1);
    } finally { await settings.cleanup(); }
  });

  it('isolates configuration and system prompts across concurrent invocations', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      await Promise.all([
        executor.execute(prepared, { system: 'SYSTEM-A', user: 'USER-A' }),
        executor.execute(prepared, { system: 'SYSTEM-B', user: 'USER-B' }),
      ]);

      const first = spawner.requests.find((request) => request.stdin === 'USER-A');
      const second = spawner.requests.find((request) => request.stdin === 'USER-B');
      expect(first?.env?.PI_CODING_AGENT_DIR).toBeDefined();
      expect(second?.env?.PI_CODING_AGENT_DIR).toBeDefined();
      expect(first?.env?.PI_CODING_AGENT_DIR).not.toBe(second?.env?.PI_CODING_AGENT_DIR);
      expect(await readFile(first!.args.at(-1)!, 'utf8')).toBe('SYSTEM-A');
      expect(await readFile(second!.args.at(-1)!, 'utf8')).toBe('SYSTEM-B');
      expect(await readFile(join(first!.env!.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'))
        .toBe(await readFile(join(second!.env!.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'));
    } finally {
      await settings.cleanup();
    }
  });

  it('uses a positive per-invocation timeout before the prepared default', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const prompt = { system: 'fixed policy', user: 'review' };
      spawner.scriptWait(80);
      expect((await executor.execute(prepared, prompt, { timeoutMs: 20 })).status).toBe('timed-out');
      expect((await executor.execute(prepared, prompt)).status).not.toBe('timed-out');
      await expect(executor.execute(prepared, prompt, { timeoutMs: 0 })).rejects.toThrow(/process timeout is invalid/u);
      expect(spawner.requests).toHaveLength(2);
    } finally {
      await settings.cleanup();
    }
  });

  it('keeps a 256 KiB untrusted review prompt out of the process argument list', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const context = 'x'.repeat(256 * 1024);
      await executor.execute(prepared, { system: 'fixed policy', user: context });
      expect(spawner.requests[0]?.stdin).toBe(context);
      expect(spawner.requests[0]?.args.every((value) => value.length < 4_096)).toBe(true);
    } finally {
      await settings.cleanup();
    }
  });

  it('uses an unauthenticated placeholder when no credential is configured', async () => {
    const settings = await createSettings({ credential: undefined });
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ spawner });
      const prepared = await executor.prepare(settings);
      await executor.execute(prepared, { system: 'S', user: 'U' });
      const agentDirectory = spawner.requests[0]?.env?.PI_CODING_AGENT_DIR;
      expect(agentDirectory).toBeDefined();
      const modelsJson = JSON.parse(await readFile(join(agentDirectory!, 'models.json'), 'utf8'));
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
      expect(run.telemetry).toMatchObject({
        processStartupMs: expect.any(Number),
        timeToFirstTextMs: null,
        stdoutBytes: Buffer.byteLength('{"type":"session"}\n'),
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      const diagnostic = JSON.parse(run.diagnostic);
      expect(diagnostic).toMatchObject({
        schema: 'pi-no-text/v1',
        class: 'missing-turn-end',
        cause: 'pi-event-stream',
        exit: 0,
        events: ['session'],
        parts: [],
        stop: null,
        outputTokens: null,
      });
      expect(diagnostic.stdout).toEqual([
        Buffer.byteLength('{"type":"session"}\n'),
        Buffer.byteLength('{"type":"session"}\n'),
        false,
      ]);
      expect(run.diagnostic.length).toBeLessThanOrEqual(500);
    } finally {
      await settings.cleanup();
    }
  });
  it('classifies each controlled exit-0 failure stream, including capture truncation', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ spawner });
      const prepared = await executor.prepare(settings);
      const cases = [
        ['missing-turn-end.ndjson', 'missing-turn-end'],
        ['malformed-events.ndjson', 'malformed-events'],
        ['missing-text-parts.ndjson', 'missing-text-parts'],
        ['empty-text.ndjson', 'empty-text'],
        ['model-output-budget.ndjson', 'model-output-budget-exhausted'],
        ['capture-truncated.ndjson', 'capture-truncated'],
      ] as const;

      for (const [fixture, classification] of cases) {
        let stdout = await readFile(join('test', 'fixtures', 'pi-events', fixture), 'utf8');
        if (classification === 'capture-truncated') stdout += 'x'.repeat(MAX_OUTPUT_BYTES);
        spawner.script(stdout, 0);

        const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' }, { streamMode: 'off' });
        const diagnostic = JSON.parse(run.diagnostic);
        expect(run.status, fixture).toBe('failed');
        expect(run.exitCode, fixture).toBe(0);
        expect(diagnostic.class, fixture).toBe(classification);
        expect(run.diagnostic.length, fixture).toBeLessThanOrEqual(500);
        if (classification === 'capture-truncated') {
          expect(diagnostic.stdout[0]).toBeGreaterThan(diagnostic.stdout[1]);
          expect(diagnostic.stdout[2]).toBe(true);
        }
      }
    } finally {
      await settings.cleanup();
    }
  });

  it('persists metadata-only diagnostics instead of stderr or model content', async () => {
    const settings = await createSettings({ credential: { provider: 'mock', value: 'SECRET_CREDENTIAL_MARKER' } });
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ spawner });
      const prepared = await executor.prepare(settings);
      const stdout = await readFile(join('test', 'fixtures', 'pi-events', 'missing-text-parts.ndjson'), 'utf8');
      spawner.script(stdout, 0, 'PRIVATE_STDERR_MARKER');

      const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' });
      const diagnostic = JSON.parse(run.diagnostic);

      expect(run.status).toBe('failed');
      expect(diagnostic).toMatchObject({
        schema: 'pi-no-text/v1',
        class: 'missing-text-parts',
        cause: 'provider-output',
        exit: 0,
        malformed: 0,
        events: ['message_end', 'turn_end', 'agent_end'],
        parts: ['thinking'],
        stop: 'stop',
        outputTokens: 8,
      });
      expect(diagnostic.durationMs).toEqual(expect.any(Number));
      expect(diagnostic.startupMs).toEqual(expect.any(Number));
      expect(run.diagnostic.length).toBeLessThanOrEqual(500);
      expect(run.diagnostic).not.toMatch(/PRIVATE_|SECRET_|thinking":/u);
    } finally {
      await settings.cleanup();
    }
  });
});

describe('inspectPiAssistantOutput', () => {
  const cases = [
    {
      fixture: 'missing-turn-end.ndjson',
      classification: 'missing-turn-end',
      causeEvidence: { stopReason: 'stop', outputTokens: 4 },
      truncated: false,
    },
    {
      fixture: 'malformed-events.ndjson',
      classification: 'malformed-events',
      causeEvidence: { malformedEvents: 1 },
      truncated: false,
    },
    {
      fixture: 'missing-text-parts.ndjson',
      classification: 'missing-text-parts',
      causeEvidence: { contentPartTypes: ['thinking'] },
      truncated: false,
    },
    {
      fixture: 'empty-text.ndjson',
      classification: 'empty-text',
      causeEvidence: { contentPartTypes: ['text'] },
      truncated: false,
    },
    {
      fixture: 'capture-truncated.ndjson',
      classification: 'capture-truncated',
      causeEvidence: { finalEventTypes: ['message_start', 'message_update'] },
      truncated: true,
    },
    {
      fixture: 'model-output-budget.ndjson',
      classification: 'model-output-budget-exhausted',
      causeEvidence: { stopReason: 'length', outputTokens: 256 },
      truncated: false,
    },
  ] as const;

  it.each(cases)('classifies $fixture as $classification', async ({ fixture, classification, causeEvidence, truncated }) => {
    const stdout = await readFile(join('test', 'fixtures', 'pi-events', fixture), 'utf8');
    const inspection = inspectPiAssistantOutput(stdout, truncated);

    expect(inspection.text).toBeUndefined();
    expect(inspection.classification).toBe(classification);
    expect(inspection).toMatchObject(causeEvidence);
  });

  it('accepts retained text after Pi confirms the selected turn is settled', () => {
    const stdout = [
      JSON.stringify({
        type: 'turn_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'complete' }] },
      }),
      JSON.stringify({ type: 'agent_end' }),
      JSON.stringify({ type: 'agent_settled', aborted: false }),
    ].join('\n');

    const inspection = inspectPiAssistantOutput(stdout, true);

    expect(inspection.text).toBe('complete');
    expect(inspection.classification).toBeUndefined();
    expect(inspection.finalEventTypes).toEqual(['turn_end', 'agent_end', 'agent_settled']);
  });

  it('rejects retained text when truncation hides whether the selected turn settled', () => {
    const stdout = [
      JSON.stringify({
        type: 'turn_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'possibly stale' }] },
      }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');

    const inspection = inspectPiAssistantOutput(stdout, true);

    expect(inspection.text).toBeUndefined();
    expect(inspection.classification).toBe('capture-truncated');
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

  it('preserves successful extraction when an earlier event is malformed', () => {
    const stdout = [
      '{"type":"message_update"',
      JSON.stringify({
        type: 'turn_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'complete' }] },
      }),
    ].join('\n');
    const inspection = inspectPiAssistantOutput(stdout);

    expect(inspection.text).toBe('complete');
    expect(inspection.classification).toBeUndefined();
    expect(inspection.malformedEvents).toBe(1);
  });

  it('streams readable text deltas and boundary lines, never raw NDJSON', async () => {
    const settings = await createSettings({ credential: { provider: 'mock', value: 'secret-key' } });
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const stdout = [
        '{"type":"session"}',
        '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"secret-key reasoning"}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","content":"full thinking"}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Finding: use "}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"guarded input."}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"payload ##[error] injected"}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"full text"}}',
        '{"type":"message_end"}',
        '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop","usage":{"input":10,"output":4,"cacheRead":2,"cacheWrite":0,"totalTokens":14,"cost":{"total":0.001}}}}',
        '',
      ].join('\n');
      spawner.script(stdout, 0);
      const tapped: Array<{ kind: string; line: string }> = [];
      const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' }, {
        onOutputLine: (output) => tapped.push({ kind: output.kind, line: output.line }),
      });

      expect(run.telemetry?.timeToFirstTextMs).toBeGreaterThanOrEqual(0);
      expect(run.telemetry?.stdoutBytes).toBe(Buffer.byteLength(stdout, 'utf8'));
      expect(run.telemetry?.usage).toEqual({
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        totalTokens: 14,
        costUsd: 0.001,
      });
      expect(run.telemetry?.retryCount).toBe(0);
      const text = tapped.filter((entry) => entry.kind === 'text').map((entry) => entry.line).join('');
      // Readable streaming text, credential-redacted, newline at segment
      // end, and workflow-command syntax neutralized.
      expect(text).toBe('[redacted] reasoning\nFinding: use guarded input.payload # #[error] injected\n');
      // Boundary lines stay compact; raw NDJSON and end-event full content
      // never pass through.
      expect(tapped.filter((entry) => entry.kind === 'line').map((entry) => entry.line)).toEqual([
        'pi event: message_end',
        'pi event: turn_end',
      ]);
      expect(text).not.toContain('full thinking');
      expect(text).not.toContain('{"type"');
    } finally {
      await settings.cleanup();
    }
  });

  it('renders dots mode as one dot per chunk with segment newlines', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const stdout = [
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"chunk one"}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"chunk two"}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"full"}}',
        '{"type":"message_end"}',
        '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop","usage":{"input":10,"output":4}}}',
        '',
      ].join('\n');
      spawner.script(stdout, 0);
      const tapped: Array<{ kind: string; line: string }> = [];
      await executor.execute(prepared, { system: 'SYS', user: 'USER' }, {
        onOutputLine: (output) => tapped.push({ kind: output.kind, line: output.line }),
        streamMode: 'dots',
      });

      const text = tapped.filter((entry) => entry.kind === 'text').map((entry) => entry.line).join('');
      expect(text).toBe('..\n');
      // Boundary lines are suppressed in dots mode.
      expect(tapped.filter((entry) => entry.kind === 'line')).toEqual([]);
    } finally {
      await settings.cleanup();
    }
  });

  it('caps the streamed text and reports truncation', async () => {
    const settings = await createSettings();
    try {
      const spawner = new RecordingSpawner();
      const executor = createPiExecutor({ command: 'pi-fake', spawner });
      const prepared = await executor.prepare(settings);
      const longDelta = 'x'.repeat(40 * 1024);
      spawner.script(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: longDelta } })}\n`, 0);
      const tapped: Array<{ kind: string; line: string }> = [];
      await executor.execute(prepared, { system: 'SYS', user: 'USER' }, {
        onOutputLine: (output) => tapped.push({ kind: output.kind, line: output.line }),
      });

      const streamedLength = tapped
        .filter((entry) => entry.kind === 'text')
        .reduce((total, entry) => total + entry.line.length, 0);
      expect(streamedLength).toBe(32 * 1024);
      expect(tapped.some((entry) => entry.kind === 'line' && entry.line.includes('truncated in the log'))).toBe(true);
    } finally {
      await settings.cleanup();
    }
  });
});
