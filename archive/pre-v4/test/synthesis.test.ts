import { describe, expect, it } from 'vitest';
import { synthesizeReview } from '../src/review/synthesis.ts';
import type { PullRequestFinding } from '../src/review/types.ts';
import { publishedFinding } from './helpers/finding.ts';
import { HEAD_SHA } from './helpers/bundle.ts';

const shared = { role: 'contract' as const, revision: HEAD_SHA, path: 'src/contract.ts',
  startLine: 2, endLine: 2, evidence: 'export const contract = true;' };

function finding(fileId: string, id: string, overrides: Partial<PullRequestFinding> = {}): PullRequestFinding {
  return {
    ...publishedFinding({ id, severity: 'high', supportingEvidence: [shared],
      verification: { status: 'confirmed', reason: 'independently checked' } }),
    triggerFileId: fileId, triggerPath: `src/${fileId}.ts`, ...overrides,
  };
}

describe('deterministic cross-file synthesis', () => {
  it('deduplicates a shared source-backed root cause but retains every changed-line trigger', () => {
    const result = synthesizeReview([finding('000002', 'b'), finding('000001', 'a')]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ status: 'coherent', representative: { fileId: '000001', findingId: 'a' } });
    expect(result.groups[0]?.triggers).toHaveLength(2);
    expect(result.groups[0]?.supportingEvidence).toEqual([shared]);
    expect(result.decisions.map((item) => item.status)).toEqual(['publish', 'duplicate']);
  });

  it('keeps distinct root causes with the same trigger separate', () => {
    const result = synthesizeReview([
      finding('000001', 'a', { rootCause: 'Missing guard' }),
      finding('000001', 'b', { rootCause: 'Incorrect cache invalidation' }),
    ]);
    expect(result.groups).toHaveLength(2);
    expect(result.decisions.map((item) => item.status)).toEqual(['publish', 'publish']);
  });

  it('suppresses incompatible source-backed contracts for human judgment', () => {
    const result = synthesizeReview([
      finding('000001', 'a', { behavioralContract: 'Must retain tenant isolation.' }),
      finding('000002', 'b', { behavioralContract: 'Must share all tenant data.' }),
    ]);
    expect(result.groups[0]).toMatchObject({ status: 'conflict', representative: null });
    expect(result.decisions.map((item) => item.status)).toEqual(['conflict', 'conflict']);
  });

  it('ranks by consequence, source strength and bounded confidence; input order cannot change the plan', () => {
    const items = [
      finding('000001', 'low', { severity: 'low', rootCause: 'low' }),
      finding('000002', 'critical', { severity: 'critical', rootCause: 'critical' }),
      finding('000003', 'strong', { rootCause: 'strong', supportingEvidence: [shared, {
        ...shared, path: 'src/second.ts', evidence: 'second();',
      }] }),
      finding('000004', 'weak', { rootCause: 'weak', confidence: 1 }),
    ];
    const result = synthesizeReview(items);
    expect(result.decisions.map((decision) => decision.findingId)).toEqual(['critical', 'strong', 'weak', 'low']);
    expect(synthesizeReview([...items].reverse())).toEqual(result);
  });

  it('applies file and inline budgets after ranking with explicit suppression decisions', () => {
    const items = [
      finding('000001', 'low', { severity: 'low', rootCause: 'low' }),
      finding('000002', 'critical', { severity: 'critical', rootCause: 'critical' }),
      finding('000003', 'high', { rootCause: 'high' }),
    ];
    const plan = synthesizeReview(items, { fileReviews: 1, inlineComments: 2 });
    expect(plan.decisions.map((decision) => `${decision.findingId}:${decision.status}`))
      .toEqual(['critical:publish', 'high:file-budget', 'low:file-budget']);
    const noComments = synthesizeReview(items, { fileReviews: 2, inlineComments: 1 });
    expect(noComments.decisions.map((decision) => `${decision.findingId}:${decision.status}`))
      .toEqual(['critical:publish', 'high:comment-budget', 'low:comment-budget']);
  });
});
