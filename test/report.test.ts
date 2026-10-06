import { describe, expect, it } from 'vitest';
import { FileReviewValidator, parseChangedLines, parseFileReviewDocument } from '../src/review/report.js';
import type { ReviewFinding } from '../src/review/types.js';
import type { ReviewManifestFile } from '../src/review/bundle.js';

const DIFF =
  'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,4 +1,4 @@\n context\n-old line\n+new line\n more context\n';

function manifestFile(overrides: Partial<ReviewManifestFile> = {}): ReviewManifestFile {
  return {
    id: '000001',
    status: 'M',
    oldPath: 'src/example.ts',
    newPath: 'src/example.ts',
    similarity: null,
    additions: 1,
    deletions: 1,
    binary: false,
    reviewed: true,
    diffFile: 'diffs/000001.diff',
    baseFile: 'base-files/000001',
    ...overrides,
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    category: 'correctness',
    classification: 'defect',
    severity: 'high',
    confidence: 0.9,
    side: 'RIGHT',
    startLine: 2,
    endLine: 2,
    evidence: 'new line',
    impact: 'Returns the wrong value.',
    fix: 'Restore the required value.',
    ...overrides,
  };
}

function document(findingOverrides: Partial<ReviewFinding> = {}) {
  return finding(findingOverrides);
}

describe('parseFileReviewDocument', () => {
  it('parses a clean document', () => {
    const parsed = parseFileReviewDocument('{"version":2,"fileId":"000001","outcome":"clean","findings":[]}');
    expect(parsed.outcome).toBe('clean');
    expect(parsed.findings).toEqual([]);
  });

  it('parses an omitted document with a reason', () => {
    const parsed = parseFileReviewDocument(
      '{"version":2,"fileId":"000001","outcome":"omitted","reason":"binary content","findings":[]}',
    );
    expect(parsed.outcome).toBe('omitted');
    expect(parsed.reason).toBe('binary content');
  });

  it('rejects older document versions', () => {
    expect(() =>
      parseFileReviewDocument('{"version":1,"fileId":"000001","outcome":"clean","findings":[]}'),
    ).toThrow(/unsupported version/u);
  });

  it('rejects invalid JSON and extra prose', () => {
    expect(() => parseFileReviewDocument('nope')).toThrow(/not valid JSON/u);
    // Fenced content is unwrapped, then strict-validated: this fenced body
    // is a valid JSON envelope but violates the schema.
    expect(() => parseFileReviewDocument('```json\n{"version":2}\n```')).toThrow();
  });

  it('unwraps a single code fence around an otherwise valid document', () => {
    const fenced = '```json\n{"version":2,"fileId":"000001","outcome":"clean","findings":[]}\n```';
    expect(parseFileReviewDocument(fenced).outcome).toBe('clean');
  });

  it('does not unwrap fenced content that contains fences', () => {
    expect(() =>
      parseFileReviewDocument('```json\n{"a":"```"}\n```'),
    ).toThrow(/not valid JSON/u);
  });

  it('rejects schema violations', () => {
    const base = (overrides: Record<string, unknown>) =>
      JSON.stringify({ version: 2, fileId: '000001', outcome: 'clean', findings: [], ...overrides });
    expect(() => parseFileReviewDocument(base({ outcome: 'spooky' }))).toThrow(/unsupported/u);
    expect(() => parseFileReviewDocument(base({ outcome: 'omitted' }))).toThrow(/reason is required/u);
    // Envelope tolerance: a reason on a non-omitted outcome is dropped.
    const cleanWithReason = parseFileReviewDocument(base({ outcome: 'clean', reason: 'why' }));
    expect(cleanWithReason.outcome).toBe('clean');
    expect(cleanWithReason.reason).toBeUndefined();
    // Envelope tolerance: findings defaults to empty for non-findings outcomes.
    const cleanWithoutFindings = parseFileReviewDocument('{"version":2,"fileId":"000001","outcome":"clean"}');
    expect(cleanWithoutFindings.findings).toEqual([]);
    expect(() => parseFileReviewDocument(base({ outcome: 'findings', findings: [] }))).toThrow(
      /requires at least one finding/u,
    );
    expect(() => parseFileReviewDocument(base({ outcome: 'clean', findings: [document()] }))).toThrow(
      /inconsistent with findings/u,
    );
    expect(() => parseFileReviewDocument(base({ extra: 1 }))).toThrow(/unsupported fields/u);
  });

  it('parses spans and optional suggested changes', () => {
    const raw = JSON.stringify({
      version: 2,
      fileId: '000001',
      outcome: 'findings',
      findings: [
        {
          ...finding({ startLine: 2, endLine: 2 }),
          suggestedChange: 'new line (guarded)',
        },
      ],
    });
    const parsed = parseFileReviewDocument(raw);
    expect(parsed.findings[0]?.startLine).toBe(2);
    expect(parsed.findings[0]?.endLine).toBe(2);
    expect(parsed.findings[0]?.suggestedChange).toBe('new line (guarded)');
  });

  it('rejects inverted spans and invalid suggested changes', () => {
    const raw = (findingOverrides: Record<string, unknown>) =>
      JSON.stringify({ version: 2, fileId: '000001', outcome: 'findings', findings: [findingOverrides] });
    expect(() => parseFileReviewDocument(raw({ ...finding(), startLine: 3, endLine: 2 }))).toThrow(
      /startLine must not exceed finding\.endLine/u,
    );
    expect(() => parseFileReviewDocument(raw({ ...finding(), suggestedChange: '' }))).toThrow(
      /suggestedChange is invalid/u,
    );
    expect(() => parseFileReviewDocument(raw({ ...finding(), suggestedChange: 'x'.repeat(9 * 1024) }))).toThrow(
      /suggestedChange is invalid/u,
    );
  });

  it('rejects malformed findings', () => {
    const raw = JSON.stringify({
      version: 2,
      fileId: '000001',
      outcome: 'findings',
      findings: [finding({ confidence: 1.5 })],
    });
    expect(() => parseFileReviewDocument(raw)).toThrow(/between 0 and 1/u);
  });

  it('enforces the ten-finding cap', () => {
    const findings = Array.from({ length: 11 }, () => finding());
    const raw = JSON.stringify({ version: 2, fileId: '000001', outcome: 'findings', findings });
    expect(() => parseFileReviewDocument(raw)).toThrow(/finding limit/u);
  });
});

describe('parseChangedLines', () => {
  it('maps changed lines to side line numbers and records context per side', () => {
    const changed = parseChangedLines(DIFF, 'diff');
    expect(changed.left.get(2)).toBe('old line');
    expect(changed.right.get(2)).toBe('new line');
    // Context lines sit at identical numbers here, but are tracked per side.
    expect(changed.contextLeft.get(1)).toBe('context');
    expect(changed.contextRight.get(1)).toBe('context');
    expect(changed.contextRight.get(3)).toBe('more context');
    expect(changed.left.has(1)).toBe(false);
    expect(changed.right.has(3)).toBe(false);
  });

  it('tracks line numbers across hunks and offset contexts', () => {
    const twoHunks =
      '--- a\n+++ b\n@@ -10,3 +12,3 @@\n ctx\n-a\n+b\n ctx2\n@@ -20,2 +20,2 @@\n ctx\n-c\n+d\n';
    const changed = parseChangedLines(twoHunks, 'diff');
    expect(changed.left.get(11)).toBe('a');
    expect(changed.right.get(13)).toBe('b');
    // Context in the second hunk of the old file sits at 20, in the new
    // file at 20 as well here, but the first hunk shifted them apart.
    expect(changed.contextLeft.get(10)).toBe('ctx');
    expect(changed.contextRight.get(12)).toBe('ctx');
    expect(changed.right.get(21)).toBe('d');
  });
});

describe('FileReviewValidator', () => {
  it('accepts a finding whose span endpoints and evidence match the diff', () => {
    const validator = new FileReviewValidator(manifestFile(), DIFF, 'defects');
    const validated = validator.validateFinding(finding());
    expect(validated.id).toMatch(/^f-[0-9a-f]{24}$/u);
  });

  it('rejects spans whose endpoints are not changed lines', () => {
    const validator = new FileReviewValidator(manifestFile(), DIFF, 'defects');
    expect(() => validator.validateFinding(finding({ startLine: 1, endLine: 2 }))).toThrow(
      /startLine is not a changed line/u,
    );
    expect(() => validator.validateFinding(finding({ startLine: 2, endLine: 3 }))).toThrow(
      /endLine is not a changed line/u,
    );
    expect(() => validator.validateFinding(finding({ startLine: 1, endLine: 3 }))).toThrow(
      /startLine is not a changed line/u,
    );
  });

  it('rejects mismatched evidence', () => {
    const validator = new FileReviewValidator(manifestFile(), DIFF, 'defects');
    expect(() => validator.validateFinding(finding({ evidence: 'new line ' }))).toThrow(
      /does not match the authoritative diff line/u,
    );
  });

  it('rejects risk findings under the defects scope', () => {
    const validator = new FileReviewValidator(manifestFile(), DIFF, 'defects');
    expect(() => validator.validateFinding(finding({ classification: 'risk' }))).toThrow(
      /disabled by the configured finding scope/u,
    );
    const expanded = new FileReviewValidator(manifestFile(), DIFF, 'defects-and-risks');
    expect(() => expanded.validateFinding(finding({ classification: 'risk' }))).not.toThrow();
  });

  it('rejects findings against binary diffs', () => {
    const validator = new FileReviewValidator(manifestFile({ binary: true }), DIFF, 'defects');
    expect(() => validator.validateFinding(finding())).toThrow(/binary/u);
  });

  it('deduplicates identical findings', () => {
    const validator = new FileReviewValidator(manifestFile(), DIFF, 'defects');
    const validated = validator.validateFindings([finding(), finding({ severity: 'low' })]);
    // finding() twice → one entry; the severity variant is a distinct finding.
    expect(validated).toHaveLength(2);
    expect(new Set(validated.map((item) => item.id)).size).toBe(2);
  });
});
