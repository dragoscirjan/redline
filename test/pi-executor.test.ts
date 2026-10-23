import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createPiExecutor,
  extractPiAssistantText,
  inspectPiAssistantOutput,
  PI_CREDENTIAL_ENV_NAME,
} from '../src/harness-executor/pi-executor.js';
import { MAX_OUTPUT_BYTES, type ProcessSpawner, type SpawnedProcess } from '../src/harness-executor/process-runner.js';
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
        join(settings.workDirectory, 'pi-agent', 'system-prompt.md'),
      ]);
      expect(request.stdin).toBe('USER');
      expect(await readFile(join(settings.workDirectory, 'pi-agent', 'system-prompt.md'), 'utf8')).toBe('SYS');
      expect((await stat(join(settings.workDirectory, 'pi-agent', 'system-prompt.md'))).mode & 0o777).toBe(0o600);
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
        '{"type":"turn_end"}',
        '',
      ].join('\n');
      spawner.script(stdout, 0);
      const tapped: Array<{ kind: string; line: string }> = [];
      const run = await executor.execute(prepared, { system: 'SYS', user: 'USER' }, {
        onOutputLine: (output) => tapped.push({ kind: output.kind, line: output.line }),
      });

      expect(run.telemetry?.timeToFirstTextMs).toBeGreaterThanOrEqual(0);
      expect(run.telemetry?.stdoutBytes).toBe(Buffer.byteLength(stdout, 'utf8'));
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
        '{"type":"turn_end"}',
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
