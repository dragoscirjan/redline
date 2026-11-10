import { describe, expect, it } from 'vitest';
import { validateWarmup } from '../src/review/warmup.ts';
import type { HarnessRun } from '../src/harness-executor/types.ts';

const head = 'a'.repeat(40), source = '/captured/head';
// Originally reproduced against v2. Keep the same zero-call claim in the current report format.
function noOp(): HarnessRun {
  return { harness: 'pi', status: 'succeeded', exitCode: 0, diagnostic: '', durationMs: 29000,
    text: JSON.stringify({ kind: 'REDLINE_NATIVE_WARMUP', head, sourceDirectory: source, integrations: [
      { component: 'context-mode', availability: 'available', tools: ['ctx_index'], reason: 'Tool visible.' },
      { component: 'sequential-thinking', availability: 'available', tools: ['sequentialthinking'], reason: 'Tool visible.' },
      { component: 'cgc', availability: 'available', tools: ['cgc_index', 'cgc_query'], indexStatus: 'ready', indexedFiles: 120,
        persistence: 'shared', probeTool: 'cgc_index', indexTool: 'cgc_index', queryTool: 'cgc_query', reason: 'Indexed 120 files and queried expected symbols.' },
    ] }),
    telemetry: { processStartupMs: null, timeToFirstTextMs: null, stdoutBytes: 0, stderrBytes: 0,
      stdoutTruncated: false, stderrTruncated: false, tools: { catalogueSource: 'harness-catalogue', truncated: false,
        catalogue: ['cgc_index', 'cgc_query', 'ctx_index', 'sequentialthinking'], calls: [] } } };
}
describe('non-cooperative native warmup regression', () => {
  it('does not complete valid JSON with invented indexing claims and no executed tools', () => {
    const result = validateWarmup(noOp(), head, source, 120000);
    expect(result.status).toBe('incomplete');
    const indexer = result.integrations.find(row => row.category === 'indexer');
    expect(indexer?.category === 'indexer' && indexer.indexedFiles).toBeNull();
  });
  it('does not assign indexing fields to optional context and reasoning tools', () => {
    const result = validateWarmup(noOp(), head, source, 120000);
    for (const component of ['context-mode', 'sequential-thinking']) {
      const row = result.integrations.find(row => row.component === component);
      expect(row).not.toHaveProperty('indexStatus'); expect(row).not.toHaveProperty('indexedFiles'); expect(row).not.toHaveProperty('persistence');
    }
  });
});
