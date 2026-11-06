import { describe, expect, it } from 'vitest';
import { validateWarmup, runNativeWarmup, warmupGuidance, WARMUP_COMPONENTS } from '../src/review/warmup.ts';
import type { HarnessExecutor, HarnessRun, HarnessSettings } from '../src/harness-executor/types.ts';

const head = 'a'.repeat(40), source = '/captured/head';
function report() {
  return { kind: 'REDLINE_NATIVE_WARMUP', head, sourceDirectory: source, integrations: WARMUP_COMPONENTS.map(component => ({
    component, availability: component === 'cgc' ? 'available' : 'unavailable',
    tools: component === 'cgc' ? ['cgc_index', 'cgc_query'] : [],
    indexStatus: component === 'cgc' ? 'ready' : 'unavailable', indexedFiles: component === 'cgc' ? 3 : null,
    persistence: component === 'cgc' ? 'shared' : 'unknown', queryTool: component === 'cgc' ? 'cgc_query' : null,
    reason: 'synthetic status',
  })) };
}
function run(value: unknown = report()): HarnessRun {
  return { status: 'succeeded', harness: 'pi', exitCode: 0, text: JSON.stringify(value), diagnostic: '', durationMs: 10,
    telemetry: { processStartupMs: null, timeToFirstTextMs: null, stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
      tools: { catalogueSource: 'harness-catalogue', catalogue: ['cgc_index', 'cgc_query'], truncated: false,
        calls: [{ name: 'cgc_query', started: 1, succeeded: 1, failed: 0 }] } } };
}
describe('native model warmup report', () => {
  it('distinguishes advisory index status from observed successful calls', () => {
    const result = validateWarmup(run(), head, source, 120000);
    expect(result.status).toBe('completed');
    expect(result.integrations[0]).toMatchObject({ availability: 'observed', indexStatus: 'reported-ready', queryObserved: true, indexedFiles: 3 });
    expect(result.integrations[1]?.availability).toBe('not-observed');
    expect(warmupGuidance(result).integrations[0]).not.toHaveProperty('reason');
  });
  it.each(['head', 'sourceDirectory', 'unknown'] as const)('rejects identity/schema mismatch %s', key => {
    expect(validateWarmup(run({ ...report(), [key]: 'wrong' }), head, source, 1000).status).toBe('invalid');
  });
  it('rejects duplicate or absent component rows', () => {
    const value = report(); value.integrations[1] = value.integrations[0]!;
    expect(validateWarmup(run(value), head, source, 1000).status).toBe('invalid');
  });
  it.each(['session-only', 'unknown'])('does not advertise %s indexes to fresh review processes', persistence => {
    const value = report(); value.integrations[0]!.persistence = persistence;
    expect(validateWarmup(run(value), head, source, 1000).integrations[0]?.indexStatus).toBe('unverified');
  });
  it('rejects invented tool visibility and contradicting failed queries', () => {
    const value = report(); value.integrations[0]!.tools = ['invented'];
    expect(validateWarmup(run(value), head, source, 1000).integrations[0]?.indexStatus).toBe('unverified');
    const original = run();
    const failed = { ...original, telemetry: { ...original.telemetry!, tools: { ...original.telemetry!.tools!, calls: [{ name: 'cgc_query', started: 1, succeeded: 0, failed: 1 }] } } };
    expect(validateWarmup(failed, head, source, 1000).integrations[0]?.indexStatus).toBe('unverified');
  });
  it('rejects fenced, oversized, malformed JSON without persisting raw output', () => {
    for (const text of ['```json\n' + run().text + '\n```', 'bad sensitive text', 'x'.repeat(32769)]) {
      const result = validateWarmup({ ...run(), text }, head, source, 1000);
      expect(result.status).toBe('invalid'); expect(JSON.stringify(result)).not.toContain(text);
    }
  });
  it('redacts selected literal and encoded credentials from status reasons', () => {
    const value = report(); const secret = 'key/private?123';
    value.integrations[0]!.reason = secret + ' ' + encodeURIComponent(secret);
    const result = JSON.stringify(validateWarmup(run(value), head, source, 1000, secret));
    expect(result).not.toContain(secret); expect(result).not.toContain(encodeURIComponent(secret));
  });
  it('separates model-reported visibility from native observations and query readiness', () => {
    const original = run();
    const unobserved = { ...original, telemetry: { ...original.telemetry!, tools: { ...original.telemetry!.tools!, catalogue: [], calls: [] } } };
    const row = validateWarmup(unobserved, head, source, 1000).integrations[0]!;
    expect(row.availability).toBe('reported'); expect(row.reportedTools).toEqual(['cgc_index', 'cgc_query']);
    expect(row.tools).toEqual([]); expect(row.queryObserved).toBe(false); expect(row.indexStatus).toBe('unverified');
  });

  it('records a timeout or shared provider failure without inventing availability', () => {
    expect(validateWarmup({ ...run(), status: 'timed-out', text: '' }, head, source, 100).status).toBe('timed-out');
    const fatal = validateWarmup({ ...run(), status: 'failed', failureScope: 'run', diagnostic: 'HTTP 401 private-key' }, head, source, 100, 'private-key');
    expect(fatal.fatal).toBe(true); expect(fatal.reason).toContain('HTTP 401'); expect(fatal.reason).not.toContain('private-key');
  });
});
describe('bounded warmup execution', () => {
  it('uses the selected harness with a shared deadline and a separate small output cap', async () => {
    const settings: HarnessSettings = { model: { provider: 'mock', endpoint: 'http://127.0.0.1/v1', model: 'mock' }, credential: undefined, timeoutMs: 240000, maxOutputTokens: 32768, workDirectory: '/work' };
    let preparations = 0;
    const executor: HarnessExecutor = { harness: 'pi', async prepare(actual) {
      preparations++; expect(actual.maxOutputTokens).toBe(4096); expect(actual.timeoutMs).toBe(4000);
      return { harness: 'pi', model: actual.model, description: 'synthetic', executionMode: 'native' };
    }, async execute(_prepared, prompt, options) {
      expect(prompt.user).toContain('REDLINE_NATIVE_WARMUP'); expect(prompt.system).toContain('fresh harness/MCP processes');
      expect(options!.timeoutMs).toBeLessThanOrEqual(4000); expect(options!.streamMode).toBe('off');
      return run();
    } };
    expect((await runNativeWarmup(executor, settings, { head, sourceDirectory: source, paths: ['sample.ts'] }, 4000)).status).toBe('completed');
    expect((await runNativeWarmup(executor, settings, { head, sourceDirectory: source, paths: [] }, 0)).status).toBe('timed-out');
    expect(preparations).toBe(1); expect(settings.maxOutputTokens).toBe(32768);
  });
});
