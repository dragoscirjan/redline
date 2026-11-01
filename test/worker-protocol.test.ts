import { describe, expect, it } from 'vitest';
import { invocationMessages, parseHostMessage, parseWorkerMessage, readPrompt, decodeData, PROTOCOL, LIMITS } from '../src/harness-worker/contract.ts';
import type { HarnessSettings } from '../src/harness-executor/types.ts';

const jobId = '00000000-0000-4000-8000-000000000001';
const settings: HarnessSettings = {
  model: { provider: 'openrouter', endpoint: 'https://private.invalid/api/v1', model: 'owner/model' },
  credential: { provider: 'openrouter', value: 'synthetic-real-key' },
  timeoutMs: 10_000, workDirectory: '/private/work', retryOwnership: 'caller', maxOutputTokens: 4096,
  modelProtocol: 'openrouter-json',
};

describe('internal worker contract', () => {
  it('projects only authorized settings and chunks exact prompt bytes', () => {
    const prompt = { system: 'fixed policy', user: 'source 雪'.repeat(20_000), responseSchema: { type: 'object' } };
    const messages = [...invocationMessages('pi', jobId, settings, prompt)];
    const serialized = JSON.stringify(messages);
    for (const privateValue of ['synthetic-real-key', 'private.invalid', '/private/work', 'credential', 'endpoint', 'workDirectory']) {
      expect(serialized).not.toContain(privateValue);
    }
    for (const message of messages) expect(parseHostMessage(message)).toEqual(message);
    const data = messages.flatMap(m => m.kind === 'input' ? [decodeData(m.data)] : []);
    expect(readPrompt(Buffer.concat(data))).toEqual(prompt);
    expect(() => [...invocationMessages('pi', jobId, settings, { system: 'fixed', user: settings.credential?.value ?? '' })]).toThrow('selected credential');
    expect(messages[0]).toMatchObject({ kind: 'invoke', model: { provider: 'openrouter', model: 'owner/model' }, maxOutputTokens: 4096 });
  });
  it('projects prompt content without host-only fingerprint metadata', () => {
    const prompt = { system: 'fixed', user: 'source', responseSchema: { type: 'object' }, policyDigest: 'host-fingerprint-only' };
    const messages = [...invocationMessages('pi', jobId, settings, prompt)];
    const bytes = Buffer.concat(messages.flatMap(m => m.kind === 'input' ? [decodeData(m.data)] : []));
    expect(readPrompt(bytes)).toEqual({ system: prompt.system, user: prompt.user, responseSchema: prompt.responseSchema });
    expect(bytes.toString()).not.toContain('host-fingerprint-only');
  });
  it('rejects unsupported versions, extra authority and invalid fields without echoing them', () => {
    const first = [...invocationMessages('pi', jobId, settings, { system: 'fixed', user: 'data' })][0];
    for (const value of [{ ...first, protocol: 'future' }, { ...first, endpoint: 'secret.invalid' },
      { ...first, credential: 'synthetic-secret' }, { ...first, timeoutMs: 0 }, { ...first, harness: 'echo' },
      { ...first, model: { provider: 'openrouter', model: 'owner/model', endpoint: 'bad' } },
      { ...first, maxOutputTokens: 1 }]) {
      expect(() => parseHostMessage(value)).toThrow('Invalid worker message');
    }
    expect(() => parseWorkerMessage({ protocol: PROTOCOL, kind: 'request.start', jobId, requestId: 1, url: 'secret.invalid', accept: 'application/json' })).toThrow('Invalid worker message');
  });
  it('enforces canonical base64, byte bounds, finite telemetry and known result members', () => {
    for (const data of ['', 'AA', 'AB==', '!!!!', Buffer.alloc(LIMITS.chunkBytes + 1).toString('base64')]) {
      expect(() => decodeData(data)).toThrow();
    }
    const result = { protocol: PROTOCOL, kind: 'result', jobId, run: { status: 'succeeded', harness: 'pi', exitCode: 0, durationMs: 1 } };
    expect(parseWorkerMessage(result)).toEqual(result);
    for (const run of [{ ...result.run, text: 'not inline' }, { ...result.run, status: ['succeeded'] }, { ...result.run, durationMs: Infinity },
      { ...result.run, telemetry: { prompt: 'no free text' } }]) {
      expect(() => parseWorkerMessage({ ...result, run })).toThrow();
    }
  });
  it('bounds prompts and rejects nested or unknown prompt authority', () => {
    expect(() => readPrompt(Buffer.from(JSON.stringify({ system: 's', user: 'u', command: 'sh' })))).toThrow();
    expect(() => readPrompt(Buffer.from([0xff]))).toThrow();
    expect(() => [...invocationMessages('pi', jobId, settings, { system: 's', user: 'x'.repeat(LIMITS.promptBytes + 1) })]).toThrow();
  });
});
