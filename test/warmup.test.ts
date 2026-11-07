import { describe, expect, it } from 'vitest';
import { validateWarmup, runNativeWarmup, warmupGuidance, WARMUP_TOOLS, type WarmupIndexer } from '../src/review/warmup.ts';
import type { HarnessExecutor, HarnessRun, HarnessSettings } from '../src/harness-executor/types.ts';

const head = 'a'.repeat(40), source = '/captured/head';
function report(provider: 'cgc' | 'gitnexus' | null = 'cgc'): { kind: string; head: string; sourceDirectory: string; integrations: Record<string, unknown>[] } {
  return { kind: 'REDLINE_NATIVE_WARMUP', head, sourceDirectory: source, integrations: [
    ...WARMUP_TOOLS.map(component => ({ component, availability: 'unavailable', tools: [], reason: 'Missing optional tool.' })),
    ...(provider === null ? [] : [{ component: provider, availability: 'available', tools: [provider + '_index', provider + '_query'],
      indexStatus: 'ready', indexedFiles: 3, persistence: 'shared', probeTool: provider + '_index', indexTool: provider + '_index',
      queryTool: provider + '_query', reason: 'Synthetic setup, not a system instruction.' }]),
  ] };
}
function run(value: unknown = report()): HarnessRun {
  return { status: 'succeeded', harness: 'pi', exitCode: 0, text: JSON.stringify(value), diagnostic: '', durationMs: 10,
    telemetry: { processStartupMs: null, timeToFirstTextMs: null, stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
      tools: { catalogueSource: 'harness-catalogue', catalogue: ['cgc_index', 'cgc_query'], truncated: false,
        calls: [{ name: 'cgc_index', started: 1, succeeded: 1, failed: 0 }, { name: 'cgc_query', started: 1, succeeded: 1, failed: 0 }] } } };
}
function indexer(result: ReturnType<typeof validateWarmup>): WarmupIndexer {
  const row = result.integrations.find((row): row is WarmupIndexer => row.category === 'indexer');
  if (row === undefined) throw new Error('test indexer missing');
  return row;
}
function calls(original: HarnessRun, value: NonNullable<NonNullable<HarnessRun['telemetry']>['tools']>['calls']): HarnessRun {
  return { ...original, telemetry: { ...original.telemetry!, tools: { ...original.telemetry!.tools!, calls: value } } };
}
describe('native model warmup report', () => {
  it('separates optional tools from the selected indexer and requires executed index plus query', () => {
    const result = validateWarmup(run(), head, source, 120000);
    expect(result.status).toBe('completed');
    expect(indexer(result)).toMatchObject({ availability: 'observed', indexStatus: 'reported-ready', indexObserved: true, queryObserved: true, indexedFiles: 3 });
    for (const row of result.integrations.filter(row => row.category === 'tool')) {
      expect(row).not.toHaveProperty('indexStatus'); expect(row).not.toHaveProperty('indexedFiles'); expect(row).not.toHaveProperty('persistence');
    }
    expect(result.integrations.some(row => row.component === 'gitnexus')).toBe(false);
    expect(JSON.stringify(warmupGuidance(result))).not.toContain('Synthetic setup');
  });
  it('does not complete fabricated 120-file setup without tool calls or retain that count', () => {
    const value = report(); value.integrations[2]!.indexedFiles = 120;
    const result = validateWarmup(calls(run(value), []), head, source, 1000);
    expect(result.status).toBe('incomplete'); expect(indexer(result).indexedFiles).toBeNull();
    expect(indexer(result).reason).not.toContain('Synthetic setup');
  });
  it('does not let a model call a visible indexer missing merely because its graph is absent', () => {
    const value = report(); Object.assign(value.integrations[2]!, { availability: 'unavailable', indexStatus: 'unavailable',
      indexedFiles: null, probeTool: 'cgc_query', indexTool: null, queryTool: null });
    const result = validateWarmup(calls(run(value), [{ name: 'cgc_query', started: 1, succeeded: 1, failed: 0 }]), head, source, 1000);
    expect(result.status).toBe('incomplete'); expect(indexer(result).indexAttempted).toBe(false);
  });
  it('does not count a reasoning call as an installation probe', () => {
    const value = report(); Object.assign(value.integrations[2]!, { availability: 'unavailable', indexStatus: 'unavailable',
      indexedFiles: null, probeTool: 'sequentialthinking', indexTool: null, queryTool: null });
    const result = validateWarmup(calls(run(value), [{ name: 'sequentialthinking', started: 1, succeeded: 1, failed: 0 }]), head, source, 1000);
    expect(result.status).toBe('incomplete'); expect(indexer(result).probeObserved).toBe(false);
  });
  it('does not treat a query without an index operation as successful setup', () => {
    const result = validateWarmup(calls(run(), [{ name: 'cgc_query', started: 1, succeeded: 1, failed: 0 }]), head, source, 1000);
    expect(result.status).toBe('incomplete'); expect(indexer(result).indexStatus).toBe('unverified');
  });
  it('does not promote context-mode or reasoning calls into selected-provider indexing evidence', () => {
    const value = report(); Object.assign(value.integrations[2]!, { tools: ['ctx_index', 'ctx_search'], indexTool: 'ctx_index', queryTool: 'ctx_search' });
    const borrowed = calls(run(value), [{ name: 'ctx_index', started: 1, succeeded: 1, failed: 0 }, { name: 'ctx_search', started: 1, succeeded: 1, failed: 0 }]);
    const result = validateWarmup(borrowed, head, source, 1000);
    expect(result.status).toBe('incomplete'); expect(indexer(result).indexStatus).toBe('unverified'); expect(indexer(result).indexedFiles).toBeNull();
  });
  it('attributes CLI execution through context-mode to the provider, not to a context indexer', () => {
    const tool = 'mcp__memory_context__ctx_execute';
    const value = report(); Object.assign(value.integrations[2]!, { tools: [tool], probeTool: null, indexTool: tool, queryTool: tool });
    const original = run(value);
    const actual = { ...original, telemetry: { ...original.telemetry!, tools: { catalogueSource: 'harness-catalogue' as const,
      catalogue: [tool], truncated: false, calls: [{ name: tool, started: 2, succeeded: 2, failed: 0 }] } } };
    const result = validateWarmup(actual, head, source, 1000);
    expect(result.status).toBe('completed'); expect(indexer(result)).toMatchObject({ component: 'cgc', availability: 'reported', indexStatus: 'reported-ready' });
    expect(result.integrations.find(row => row.component === 'context-mode')).not.toHaveProperty('indexedFiles');
  });
  it('does not count one shell call as both indexing and a query', () => {
    const value = report(); Object.assign(value.integrations[2]!, { tools: ['bash'], probeTool: 'bash', indexTool: 'bash', queryTool: 'bash' });
    const result = validateWarmup(calls(run(value), [{ name: 'bash', started: 1, succeeded: 1, failed: 0 }]), head, source, 1000);
    expect(indexer(result).indexStatus).toBe('unverified');
  });
  it.each(['head', 'sourceDirectory', 'unknown'] as const)('rejects identity/schema mismatch %s', key => {
    expect(validateWarmup(run({ ...report(), [key]: 'wrong' }), head, source, 1000).status).toBe('invalid');
  });
  it('preserves proven catalog visibility after invalid JSON without giving optional tools indexing fields', () => {
    const original = run();
    const catalogue = ['mcp__codeindex_cgc__find_code', 'mcp__sequential_thinking__sequentialthinking'];
    const invalid = { ...original, text: '{"broken":true}', telemetry: { ...original.telemetry!, tools: { ...original.telemetry!.tools!, catalogue, calls: [] } } };
    const result = validateWarmup(invalid, head, source, 1000);
    expect(indexer(result)).toMatchObject({ availability: 'observed', indexStatus: 'unverified' });
    const reasoning = result.integrations.find(row => row.component === 'sequential-thinking');
    expect(reasoning?.availability).toBe('observed'); expect(reasoning).not.toHaveProperty('indexedFiles');
  });
  it('warns and continues after an actually probed missing provider', () => {
    const value = report(); Object.assign(value.integrations[2]!, { availability: 'unavailable', tools: [], indexStatus: 'unavailable', indexedFiles: null,
      persistence: 'unknown', probeTool: 'bash', indexTool: null, queryTool: null });
    const original = run(value);
    const missing = { ...calls(original, [{ name: 'bash', started: 1, succeeded: 0, failed: 1 }]),
      telemetry: { ...original.telemetry!, tools: { ...original.telemetry!.tools!, catalogue: ['bash'], calls: [{ name: 'bash', started: 1, succeeded: 0, failed: 1 }] } } };
    const result = validateWarmup(missing, head, source, 1000);
    expect(result.status).toBe('completed'); expect(indexer(result).indexStatus).toBe('unavailable'); expect(result.fatal).toBe(false);
  });
  it('does not accept optional tool indexing metadata or unselected provider rows', () => {
    const value = report(); Object.assign(value.integrations[0]!, { indexedFiles: 120 });
    expect(validateWarmup(run(value), head, source, 1000).status).toBe('invalid');
    expect(validateWarmup(run(report('gitnexus')), head, source, 1000).status).toBe('invalid');
  });
  it('identifies the invalid field without retaining its value', () => {
    const value = report(); value.integrations[1]!.availability = 'private-invalid-value';
    const result = validateWarmup(run(value), head, source, 1000);
    expect(result.reason).toContain('integrations[1].availability'); expect(JSON.stringify(result)).not.toContain('private-invalid-value');
  });
  it('rejects duplicate or absent component rows', () => {
    const value = report(); value.integrations[1] = value.integrations[0]!;
    expect(validateWarmup(run(value), head, source, 1000).status).toBe('invalid');
  });
  it.each(['session-only', 'unknown'])('does not advertise %s indexes to fresh processes', persistence => {
    const value = report(); value.integrations[2]!.persistence = persistence;
    expect(indexer(validateWarmup(run(value), head, source, 1000)).indexStatus).toBe('unverified');
  });
  it('does not promote failed queries or unknown file counts', () => {
    const value = report(); value.integrations[2]!.indexedFiles = null;
    expect(indexer(validateWarmup(run(value), head, source, 1000)).indexStatus).toBe('unverified');
    const failed = calls(run(), [{ name: 'cgc_index', started: 1, succeeded: 1, failed: 0 }, { name: 'cgc_query', started: 1, succeeded: 0, failed: 1 }]);
    expect(indexer(validateWarmup(failed, head, source, 1000)).indexStatus).toBe('unverified');
  });
  it('rejects fenced, oversized and malformed JSON without persisting raw output', () => {
    for (const text of ['```json\n' + run().text + '\n```', 'bad sensitive text', 'x'.repeat(32769)]) {
      const result = validateWarmup({ ...run(), text }, head, source, 1000);
      expect(result.status).toBe('invalid'); expect(JSON.stringify(result)).not.toContain(text);
    }
  });
  it('redacts selected literal and encoded credentials from status reasons', () => {
    const value = report(); const secret = 'key/private?123'; value.integrations[2]!.reason = secret + ' ' + encodeURIComponent(secret);
    const result = JSON.stringify(validateWarmup(run(value), head, source, 1000, secret));
    expect(result).not.toContain(secret); expect(result).not.toContain(encodeURIComponent(secret));
  });
  it('records timeout and confirmed shared provider failures', () => {
    expect(validateWarmup({ ...run(), status: 'timed-out', text: '' }, head, source, 100).status).toBe('timed-out');
    const fatal = validateWarmup({ ...run(), status: 'failed', failureScope: 'run', diagnostic: 'HTTP 401 private-key' }, head, source, 100, 'private-key');
    expect(fatal.fatal).toBe(true); expect(fatal.reason).toContain('HTTP 401'); expect(fatal.reason).not.toContain('private-key');
  });
});
describe('bounded warmup execution', () => {
  const settings: HarnessSettings = { model: { provider: 'mock', endpoint: 'http://127.0.0.1/v1', model: 'mock' }, credential: undefined,
    timeoutMs: 240000, maxOutputTokens: 32768, workDirectory: '/work' };
  it('uses a tools-first prompt, selected provider, shared deadline and separate output cap', async () => {
    let preparations = 0;
    const executor: HarnessExecutor = { harness: 'pi', async prepare(actual) {
      preparations++; expect(actual.maxOutputTokens).toBe(4096); expect(actual.timeoutMs).toBeLessThanOrEqual(4000);
      return { harness: 'pi', model: actual.model, description: 'synthetic', executionMode: 'native' };
    }, async execute(_prepared, prompt, options) {
      const user = JSON.parse(prompt.user);
      expect(user.indexingProvider).toBe('cgc'); expect(prompt.toolUse).toBe('required-first'); expect(prompt.responseSchema).toBeUndefined();
      expect(prompt.system).toContain('redline-native-warmup/v3'); expect(prompt.system).toContain('NOT repository code indexers');
      expect(prompt.system).toContain('ALL_TOOLS'); expect(options!.timeoutMs).toBeLessThanOrEqual(4000);
      return run();
    } };
    expect((await runNativeWarmup(executor, settings, { head, sourceDirectory: source, paths: ['sample.ts'], indexingProvider: 'cgc' }, 4000)).status).toBe('completed');
    expect((await runNativeWarmup(executor, settings, { head, sourceDirectory: source, paths: [] }, 0)).status).toBe('timed-out');
    expect(preparations).toBe(1); expect(settings.maxOutputTokens).toBe(32768);
  });
  it('does not start a model request after preparation exhausts the warmup budget', async () => {
    let executed = 0;
    const executor: HarnessExecutor = { harness: 'pi', async prepare(actual) {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { harness: 'pi', model: actual.model, description: 'slow synthetic preparation', executionMode: 'native' };
    }, async execute() { executed++; return run(); } };
    const result = await runNativeWarmup(executor, settings, { head, sourceDirectory: source, paths: [], indexingProvider: 'cgc' }, 5);
    expect(executed).toBe(0); expect(result.status).toBe('timed-out'); expect(result.fatal).toBe(true);
  });
  it('bounds correction of a zero-call model and does not start analysis with an installed unexecuted provider', async () => {
    let callsMade = 0;
    const executor: HarnessExecutor = { harness: 'pi', async prepare(actual) { return { harness: 'pi', model: actual.model, description: 'synthetic', executionMode: 'native' }; },
      async execute() { callsMade++; return calls(run(), []); } };
    const result = await runNativeWarmup(executor, settings, { head, sourceDirectory: source, paths: [], indexingProvider: 'cgc' }, 4000);
    expect(callsMade).toBe(2); expect(result.status).toBe('incomplete'); expect(result.fatal).toBe(true);
  });
  it('does not request any code index when indexing is disabled', async () => {
    const executor: HarnessExecutor = { harness: 'pi', async prepare(actual) { return { harness: 'pi', model: actual.model, description: 'synthetic', executionMode: 'native' }; },
      async execute(_prepared, prompt) { expect(JSON.parse(prompt.user).indexingProvider).toBeNull(); return run(report(null)); } };
    const result = await runNativeWarmup(executor, settings, { head, sourceDirectory: source, paths: [], indexingProvider: null }, 4000);
    expect(result.integrations).toHaveLength(2); expect(result.integrations.every(row => row.category === 'tool')).toBe(true);
  });
});
