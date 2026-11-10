import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FollowUpBudget, type FollowUpRequestBatch } from '../src/code-context/follow-up.ts';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { classifyFollowUpSourceFailure, followUpSourcesByCandidate, resolveFollowUpResults } from '../src/review/follow-up.ts';
import { SourceMismatchError } from '../src/review/source-evidence.ts';
import { parseVerificationDocument, validateVerificationDocument } from '../src/review/verification.ts';
import { BASE_SHA, createBundleFixture, HEAD_SHA } from './helpers/bundle.ts';
import { reviewFinding } from './helpers/finding.ts';

const candidateId = `f-${'1'.repeat(24)}`;
const provider = { id: 'cgc' as const, version: '0.5.7' };

function request(): FollowUpRequestBatch {
  return new FollowUpBudget().plan({ repository: 'owner/repo', base: BASE_SHA, head: HEAD_SHA },
    '000001', 'src/example.ts', [candidateId], [{ candidateId, direction: 'incoming' }]);
}

function results(plan: FollowUpRequestBatch, overrides: Record<string, unknown> = {}): string {
  const document = {
    version: 1, repository: plan.repository, base: plan.base, head: plan.head,
    provider, snapshot: plan.base,
    results: [{ requestId: plan.requests[0]?.id, status: 'complete', reason: null, durationMs: 3,
      spans: [{ path: 'src/related.ts', revision: HEAD_SHA,
        startLine: 1, endLine: 1, evidence: 'export const related = true;',
        relationship: 'related-symbol-calls-changed-code' }] }],
  };
  return JSON.stringify({ ...document, ...overrides });
}

describe('follow-up source re-resolution', () => {
  it('classifies typed source disagreements regardless of error wording', () => {
    expect(classifyFollowUpSourceFailure(new SourceMismatchError('does not match captured source')))
      .toBe('source-disagreement');
    expect(classifyFollowUpSourceFailure(new SourceMismatchError('the captured line changed')))
      .toBe('source-disagreement');
    expect(classifyFollowUpSourceFailure(new Error('does not match captured source')))
      .toBe('source-unavailable');
    expect(classifyFollowUpSourceFailure(new Error('source file is missing')))
      .toBe('source-unavailable');
    expect(classifyFollowUpSourceFailure({ message: 'the captured line changed' }))
      .toBe('source-unavailable');
  });
  it('accepts bounded action facts only when exact-head source confirms the anchor', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src/related.ts'), 'export const related = true;\n');
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const plan = request();
      const resolved = await resolveFollowUpResults(bundle, plan, results(plan), provider);
      expect(resolved).toMatchObject([{ status: 'complete', reason: null, candidateId,
        sources: [{ path: 'src/related.ts', revision: HEAD_SHA,
          startLine: 1, evidence: 'export const related = true;' }] }]);
      expect(followUpSourcesByCandidate(resolved).get(candidateId)).toHaveLength(1);
      await writeFile(join(fixture.source, 'src/related.ts'), 'export const related = false;\n');
      const changed = await resolveFollowUpResults(bundle, plan, results(plan), provider);
      expect(changed).toMatchObject([{ status: 'partial', reason: 'source-disagreement', sources: [] }]);
      expect(followUpSourcesByCandidate(changed).size).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('permits only re-resolved candidate-scoped follow-up citations; graph-only claims remain unconfirmed', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src/related.ts'), 'export const related = true;\n');
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const plan = request();
      const evidence = (await resolveFollowUpResults(bundle, plan, results(plan), provider));
      const candidate = { ...reviewFinding({ evidence: 'new' }), id: candidateId };
      const cited = parseVerificationDocument(JSON.stringify({
        version: 1, fileId: file.id,
        results: [{ candidateId, disposition: 'confirmed', reason: 'Rechecked the captured source.',
          citations: evidence[0]?.sources }],
      }), file.id, [candidate]);
      await expect(validateVerificationDocument(bundle, file, [candidate], cited, 'defects'))
        .rejects.toThrow('not a validated candidate source location');
      await expect(validateVerificationDocument(bundle, file, [candidate], cited, 'defects',
        followUpSourcesByCandidate(evidence))).resolves.toMatchObject([{ finding: { id: candidateId } }]);
      const graphOnly = parseVerificationDocument(JSON.stringify({
        version: 1, fileId: file.id,
        results: [{ candidateId, disposition: 'confirmed', reason: 'A graph edge alone suggests reachability.', citations: [] }],
      }), file.id, [candidate]);
      await expect(validateVerificationDocument(bundle, file, [candidate], graphOnly, 'defects',
        followUpSourcesByCandidate(evidence))).rejects.toThrow('needs source evidence');
      await writeFile(join(fixture.source, 'src/related.ts'), 'export const related = false;\n');
      await expect(validateVerificationDocument(bundle, file, [candidate], cited, 'defects',
        followUpSourcesByCandidate(evidence))).rejects.toThrow('does not match captured source');
    } finally {
      await fixture.cleanup();
    }
  });

  it('degrades ambiguous paths without laundering valid sibling spans into evidence', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const plan = request();
      const unresolved = await resolveFollowUpResults(bundle, plan, results(plan), provider);
      expect(unresolved).toMatchObject([{ status: 'partial', reason: 'source-unavailable', sources: [] }]);
      const unsupported = await resolveFollowUpResults(bundle, plan, results(plan, {
        results: [{ requestId: plan.requests[0]?.id, status: 'unsupported', reason: 'language-unsupported',
          durationMs: 0, spans: [] }],
      }), provider);
      expect(unsupported).toMatchObject([{ status: 'unsupported', reason: 'language-unsupported', sources: [] }]);
      await expect(resolveFollowUpResults(bundle, { ...plan, head: BASE_SHA }, results(plan), provider))
        .rejects.toThrow('loaded source snapshot');
    } finally {
      await fixture.cleanup();
    }
  });
});
