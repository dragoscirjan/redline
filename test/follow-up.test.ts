import { describe, expect, it } from 'vitest';
import {
  FOLLOW_UP_LIMITS, FollowUpBudget, parseFollowUpResults,
  type FollowUpRequestBatch, type FollowUpResultBatch,
} from '../src/code-context/follow-up.js';

const identity = {
  repository: 'owner/repo',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
};
const provider = { id: 'cgc' as const, version: '0.5.7' };
const first = `f-${'1'.repeat(24)}`;
const second = `f-${'2'.repeat(24)}`;

function batch(): FollowUpRequestBatch {
  return new FollowUpBudget().plan(identity, '000001', 'src/example.ts', [first], [
    { candidateId: first, direction: 'incoming' },
  ]);
}

function result(
  request: FollowUpRequestBatch = batch(),
  overrides: Record<string, unknown> = {},
): string {
  const value: FollowUpResultBatch = {
    version: 1, ...identity, provider, snapshot: identity.base,
    results: request.requests.map((entry) => ({
      requestId: entry.id, status: 'complete', reason: null, durationMs: 2,
      spans: [{
        path: 'src/related.ts', revision: identity.head, startLine: 2, endLine: 3,
        evidence: 'export function call() {', relationship: entry.direction === 'incoming'
          ? 'related-symbol-calls-changed-code' : 'changed-code-calls-related-symbol',
      }],
    })),
  };
  return JSON.stringify({ ...value, ...overrides });
}

describe('action-owned follow-up exchange contract', () => {
  it('derives stable non-executable requests from validated candidates with fixed budgets', () => {
    const budget = new FollowUpBudget();
    const planned = budget.plan(identity, '000001', 'src/example.ts', [first, second], [
      { candidateId: first, direction: 'incoming' },
      { candidateId: first, direction: 'incoming' },
      { candidateId: second, direction: 'outgoing' },
      { candidateId: first, direction: 'outgoing' },
    ]);
    expect(planned.requests).toHaveLength(2);
    expect(planned.omitted).toBe(1);
    expect(planned.requests[0]).toMatchObject({
      fileId: '000001', candidateId: first, changedPath: 'src/example.ts', capability: 'related-spans',
      direction: 'incoming', depth: 1, fanOut: 8, resultLimit: 8,
    });
    expect(planned.requests[0]?.id).toMatch(/^related-span:sha256:[0-9a-f]{64}$/u);
    expect(planned.requests).toEqual(new FollowUpBudget().plan(identity, '000001', 'src/example.ts',
      [first, second], [
        { candidateId: first, direction: 'incoming' },
        { candidateId: first, direction: 'incoming' },
        { candidateId: second, direction: 'outgoing' },
        { candidateId: first, direction: 'outgoing' },
      ]).requests);
    let emitted = planned.requests.length;
    for (let i = 2; i <= 5; i += 1) {
      emitted += budget.plan(identity, String(i).padStart(6, '0'), `src/file-${i}.ts`, [first], [
        { candidateId: first, direction: 'incoming' },
        { candidateId: first, direction: 'outgoing' },
      ]).requests.length;
    }
    expect(emitted).toBe(FOLLOW_UP_LIMITS.requestsPerRun);
    expect(() => budget.plan(identity, '000006', '../outside.ts', [first], []))
      .toThrow('normalized source path');
    expect(() => new FollowUpBudget().plan(identity, '000001', 'src/example.ts', [first], [
      { candidateId: second, direction: 'incoming' },
    ])).toThrow('validated candidate');
    expect(() => new FollowUpBudget().plan(identity, '000001', 'src/example.ts', [first], [
      { candidateId: first, direction: 'MATCH (x) DELETE x' as 'incoming' },
    ])).toThrow('validated candidate and direction');
  });

  it('enforces cumulative source, result, and duration budgets across separate files', () => {
    const sourceBudget = new FollowUpBudget();
    for (let index = 0; index < 3; index += 1) {
      sourceBudget.consume('[]', [{ durationMs: 1, sources: [{ evidence: 'x'.repeat(16_000) }] }]);
    }
    expect(() => sourceBudget.consume('[]', [{ durationMs: 1, sources: [{ evidence: 'x'.repeat(1_153) }] }]))
      .toThrow('cumulative follow-up');
    const resultBudget = new FollowUpBudget();
    resultBudget.consume('x'.repeat(140_000), []);
    expect(() => resultBudget.consume('x'.repeat(140_000), [])).toThrow('cumulative follow-up');
    const timeBudget = new FollowUpBudget();
    for (let index = 0; index < 6; index += 1) timeBudget.consume('[]', [{ durationMs: 20_000, sources: [] }]);
    expect(() => timeBudget.consume('[]', [{ durationMs: 1, sources: [] }])).toThrow('cumulative follow-up');
    const wallClock = new FollowUpBudget();
    wallClock.consume('[]', [{ durationMs: 0, sources: [] }], 119_999);
    expect(wallClock.remainingTimeMs()).toBe(1);
    expect(() => wallClock.consume('[]', [{ durationMs: 0, sources: [] }], 2))
      .toThrow('cumulative follow-up');
    wallClock.spendFailure(2);
    expect(wallClock.remainingTimeMs()).toBe(0);
    expect(() => wallClock.plan(identity, '000001', 'src/app.ts', [first],
      [{ candidateId: first, direction: 'incoming' }])).toThrow('cumulative follow-up');
  });

  it('accepts only exact provider, base/head and request identity with bounded head spans', () => {
    const planned = batch();
    const accepted = parseFollowUpResults(result(planned), planned, provider);
    expect(accepted.results[0]?.spans[0]).toMatchObject({ revision: identity.head, path: 'src/related.ts' });
    expect(() => parseFollowUpResults(result(planned, { head: 'c'.repeat(40) }), planned, provider))
      .toThrow('exact review identity');
    expect(() => parseFollowUpResults(result(planned, { snapshot: identity.head }), planned, provider))
      .toThrow('version or base snapshot');
    expect(() => parseFollowUpResults(result(planned, { provider: { id: 'gitnexus', version: '1.6.12' } }), planned, provider))
      .toThrow('provider version');
    expect(() => parseFollowUpResults(result(planned, { results: [] }), planned, provider))
      .toThrow('cover every request');
    expect(() => parseFollowUpResults(result(planned, { results: [{
      ...accepted.results[0], requestId: `related-span:sha256:${'0'.repeat(64)}`,
    }] }), planned, provider)).toThrow('identity');
  });

  it('rejects malicious paths, invented head source, mismatched direction and unbounded output', () => {
    const planned = batch();
    const accepted = parseFollowUpResults(result(planned), planned, provider);
    const item = accepted.results[0]!;
    const span = item.spans[0]!;
    for (const path of ['../escape.ts', '/tmp/escape.ts', 'src\\escape.ts', 'src/./escape.ts']) {
      expect(() => parseFollowUpResults(result(planned, { results: [{ ...item,
        spans: [{ ...span, path }],
      }] }), planned, provider)).toThrow('normalized source path');
    }
    expect(() => parseFollowUpResults(result(planned, { results: [{ ...item,
      spans: [{ ...span, revision: identity.base }],
    }] }), planned, provider)).toThrow('exact head');
    expect(() => parseFollowUpResults(result(planned, { results: [{ ...item,
      spans: [{ ...span, relationship: 'changed-code-calls-related-symbol' }],
    }] }), planned, provider)).toThrow('conflicts with the request');
    expect(() => parseFollowUpResults(result(planned, { results: [{ ...item,
      durationMs: FOLLOW_UP_LIMITS.millisecondsPerRequest + 1,
    }] }), planned, provider)).toThrow('time limit');
    expect(() => parseFollowUpResults(' '.repeat(FOLLOW_UP_LIMITS.resultBytesPerRun + 1), planned, provider))
      .toThrow('run byte budget');
  });

  it('preserves explicit provider-unavailable coverage without fabricating graph spans', () => {
    const planned = batch();
    const missing = JSON.stringify({
      version: 1, ...identity, provider: null, snapshot: null,
      results: [{ requestId: planned.requests[0]?.id, status: 'unavailable',
        reason: 'not-configured', durationMs: 0, spans: [] }],
    });
    expect(parseFollowUpResults(missing, planned, null).results[0]).toMatchObject({
      status: 'unavailable', reason: 'not-configured', spans: [],
    });
    expect(() => parseFollowUpResults(missing, planned, provider)).toThrow('follow-up provider');
    expect(() => parseFollowUpResults(result(planned), planned, null)).toThrow('unavailable provider');
  });
});
