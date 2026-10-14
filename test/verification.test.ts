import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadReviewBundle } from '../src/review/bundle.js';
import { parseVerificationDocument, validateVerificationDocument } from '../src/review/verification.js';
import type { ValidatedFinding } from '../src/review/types.js';
import { BASE_SHA, createBundleFixture, HEAD_SHA } from './helpers/bundle.js';
import { reviewFinding } from './helpers/finding.js';

const FIRST = `f-${'1'.repeat(24)}`;
const SECOND = `f-${'2'.repeat(24)}`;

function candidate(id = FIRST): ValidatedFinding {
  return { ...reviewFinding({ evidence: 'new' }), id };
}

function citation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'contract',
    revision: HEAD_SHA,
    path: 'src/example.ts',
    startLine: 1,
    endLine: 1,
    evidence: 'new',
    ...overrides,
  };
}

function result(
  candidateId = FIRST,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    candidateId,
    disposition: 'confirmed',
    reason: 'Fresh review checked the changed source against the contract.',
    citations: [citation()],
    ...overrides,
  };
}

function document(results: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ version: 1, fileId: '000001', results });
}

describe('source-backed candidate verification contract', () => {
  it('covers every candidate exactly once without accepting extra, duplicate, or missing identities', () => {
    const candidates = [candidate(), candidate(SECOND)];
    expect(parseVerificationDocument(document([result(), result(SECOND)]), '000001', candidates).results).toHaveLength(2);
    expect(() => parseVerificationDocument(document([result()]), '000001', candidates)).toThrow('exactly');
    expect(() => parseVerificationDocument(document([result(), result()]), '000001', candidates)).toThrow('identities');
    expect(() => parseVerificationDocument(document([result(), result(`f-${'3'.repeat(24)}`)]), '000001', candidates))
      .toThrow('identities');
    expect(() => parseVerificationDocument(document([result()]), '000002', [candidate()]))
      .toThrow('identity');
  });

  it('rejects malformed dispositions, excessive output, and unbounded citation fields', () => {
    expect(() => parseVerificationDocument(document([result(FIRST, { unknown: true })]), '000001', [candidate()]))
      .toThrow('unsupported fields');
    expect(() => parseVerificationDocument(document([result(FIRST, { citations: [citation({ path: '../escape.ts' })] })]), '000001', [candidate()]))
      .not.toThrow(); // Resolution, not parsing, checks path authority.
    expect(() => parseVerificationDocument(document([result(FIRST, { citations: Array(5).fill(citation()) })]), '000001', [candidate()]))
      .toThrow('bounded array');
    expect(() => parseVerificationDocument('x'.repeat(64 * 1024 + 1), '000001', [candidate()]))
      .toThrow('byte limit');
  });

  it('re-resolves a changed trigger and rejects invented or stale citations', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const accepted = parseVerificationDocument(document([result()]), file.id, [candidate()]);
      const verified = await validateVerificationDocument(bundle, file, [candidate()], accepted, 'defects');
      expect(verified[0]?.finding?.verification).toMatchObject({ status: 'confirmed' });

      const altered = parseVerificationDocument(document([result(FIRST, {
        citations: [citation({ evidence: 'invented line' })],
      })]), file.id, [candidate()]);
      await expect(validateVerificationDocument(bundle, file, [candidate()], altered, 'defects'))
        .rejects.toThrow('not a validated candidate');

      await writeFile(join(fixture.source, 'src/example.ts'), 'changed since capture\n');
      await expect(validateVerificationDocument(bundle, file, [candidate()], accepted, 'defects'))
        .rejects.toThrow('does not match captured source');
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts a previously validated supporting span without giving graph facts source authority', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src/related.ts'), 'export const allowed = false;\n');
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const support = {
        role: 'caller-assumption' as const,
        revision: HEAD_SHA,
        path: 'src/related.ts',
        startLine: 1,
        endLine: 1,
        evidence: 'export const allowed = false;',
      };
      const finding = candidate();
      const supported: ValidatedFinding = { ...finding, supportingEvidence: [support] };
      const report = parseVerificationDocument(document([result(FIRST, { citations: [support] })]), file.id, [supported]);
      await expect(validateVerificationDocument(bundle, file, [supported], report, 'defects')).resolves.toHaveLength(1);
      await expect(validateVerificationDocument(bundle, file, [finding], report, 'defects'))
        .rejects.toThrow('not a validated candidate');
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed on missing source, out-of-scope reclassification, and unsupported human questions', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const missing = parseVerificationDocument(document([result(FIRST, { citations: [] })]), file.id, [candidate()]);
      await expect(validateVerificationDocument(bundle, file, [candidate()], missing, 'defects'))
        .rejects.toThrow('needs source evidence');
      const changed = parseVerificationDocument(document([result(FIRST, {
        disposition: 'reclassified', classification: 'risk',
      })]), file.id, [candidate()]);
      await expect(validateVerificationDocument(bundle, file, [candidate()], changed, 'defects'))
        .rejects.toThrow('outside the configured finding scope');
      await expect(validateVerificationDocument(bundle, file, [candidate()], changed, 'defects-and-risks'))
        .resolves.toMatchObject([{ finding: { classification: 'risk', verification: { status: 'confirmed' } } }]);
      expect(() => parseVerificationDocument(document([result(FIRST, {
        disposition: 'human-question', classification: 'defect',
      })]), file.id, [candidate()])).toThrow('question classification');
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps nonpublishable dispositions separate and rejects invalid duplicate references', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const findings = [candidate(), candidate(SECOND)];
      const report = parseVerificationDocument(document([
        result(FIRST, { disposition: 'rejected', citations: [] }),
        result(SECOND, { disposition: 'duplicate', duplicateOf: FIRST, citations: [] }),
      ]), file.id, findings);
      const dispositions = await validateVerificationDocument(bundle, file, findings, report, 'defects');
      expect(dispositions.map((item) => item.finding)).toEqual([undefined, undefined]);
      expect(() => parseVerificationDocument(document([
        result(FIRST, { disposition: 'duplicate', duplicateOf: FIRST }),
        result(SECOND),
      ]), file.id, findings)).toThrow('another validated candidate');
      expect(() => parseVerificationDocument(document([result(FIRST, {
        disposition: 'duplicate', duplicateOf: `f-${'3'.repeat(24)}`,
      })]), file.id, [candidate()])).toThrow('another validated candidate');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects base claims when the base path was not captured, even with a matching digest', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const claim = parseVerificationDocument(document([result(FIRST, {
        citations: [citation({ revision: BASE_SHA, evidence: 'old' })],
      })]), file.id, [candidate()]);
      await expect(validateVerificationDocument(bundle, file, [candidate()], claim, 'defects'))
        .rejects.toThrow('not a validated candidate source location');
    } finally {
      await fixture.cleanup();
    }
  });
});
