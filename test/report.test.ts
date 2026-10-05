import { describe, expect, it } from 'vitest';
import { FileReviewValidator, parseChangedLines, parseFileReviewDocument } from '../src/review/report.js';
import type { ReviewFinding } from '../src/review/types.js';
import type { ReviewManifestFile } from '../src/review/bundle.js';

const DIFF = 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,3 @@\n context\n-old line\n+new line\n more context\n';

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
    line: 2,
    evidence: 'new line',
    impact: 'Returns the wrong value.',
    fix: 'Restore the required value.',
    ...overrides,
  };
}

describe('parseFileReviewDocument', () => {
  it('parses a clean document', () => {
    const document = parseFileReviewDocument('{"version":1,"fileId":"000001","outcome":"clean","findings":[]}');
    expect(document.outcome).toBe('clean');
    expect(document.findings).toEqual([]);
  });

  it('parses an omitted document with a reason', () => {
    const document = parseFileReviewDocument(
      '{"version":1,"fileId":"000001","outcome":"omitted","reason":"binary content","findings":[]}',
    );
    expect(document.outcome).toBe('omitted');
    expect(document.reason).toBe('binary content');
  });

  it('rejects invalid JSON, fences, and extra prose', () => {
    expect(() => parseFileReviewDocument('nope')).toThrow(/not valid JSON/u);
    expect(() => parseFileReviewDocument('```json\n{"version":1}\n```')).toThrow();
  });

  it('rejects schema violations', () => {
    const base = (overrides: Record<string, unknown>) =>
      JSON.stringify({ version: 1, fileId: '000001', outcome: 'clean', findings: [], ...overrides });
    expect(() => parseFileReviewDocument(base({ version: 2 }))).toThrow(/unsupported version/u);
    expect(() => parseFileReviewDocument(base({ outcome: 'spooky' }))).toThrow(/unsupported/u);
    expect(() => parseFileReviewDocument(base({ outcome: 'omitted' }))).toThrow(/reason is required/u);
    expect(() => parseFileReviewDocument(base({ outcome: 'clean', reason: 'why' }))).toThrow(
      /reason is only valid/u,
    );
    expect(() => parseFileReviewDocument(base({ outcome: 'findings', findings: [] }))).toThrow(
      /requires at least one finding/u,
    );
    expect(() => parseFileReviewDocument(base({ outcome: 'clean', findings: [finding()] }))).toThrow(
      /inconsistent with findings/u,
    );
    expect(() => parseFileReviewDocument(base({ extra: 1 }))).toThrow(/unsupported fields/u);
  });

  it('rejects malformed findings', () => {
    const raw = JSON.stringify({
      version: 1,
      fileId: '000001',
      outcome: 'findings',
      findings: [finding({ confidence: 1.5 })],
    });
    expect(() => parseFileReviewDocument(raw)).toThrow(/between 0 and 1/u);
  });

  it('enforces the ten-finding cap', () => {
    const findings = Array.from({ length: 11 }, () => finding());
    const raw = JSON.stringify({ version: 1, fileId: '000001', outcome: 'findings', findings });
    expect(() => parseFileReviewDocument(raw)).toThrow(/finding limit/u);
  });
});

describe('parseChangedLines', () => {
  it('maps removed and added lines to side line numbers', () => {
    const changed = parseChangedLines(DIFF, 'diff');
    expect(changed.left.get(2)).toBe('old line');
    expect(changed.right.get(2)).toBe('new line');
    expect(changed.left.has(1)).toBe(false);
    expect(changed.right.has(3)).toBe(false);
  });

  it('tracks line numbers across hunks', () => {
    const twoHunks =
      '--- a\n+++ b\n@@ -10,2 +10,2 @@\n ctx\n-a\n+b\n@@ -20,2 +20,2 @@\n ctx\n-c\n+d\n';
    const changed = parseChangedLines(twoHunks, 'diff');
    expect(changed.left.get(11)).toBe('a');
    expect(changed.right.get(21)).toBe('d');
  });
});

describe('FileReviewValidator', () => {
  it('accepts a finding whose line and evidence match the diff', () => {
    const validator = new FileReviewValidator(manifestFile(), DIFF, 'defects');
    const validated = validator.validateFinding(finding());
    expect(validated.id).toMatch(/^f-[0-9a-f]{24}$/u);
  });

  it('rejects findings outside changed lines or with mismatched evidence', () => {
    const validator = new FileReviewValidator(manifestFile(), DIFF, 'defects');
    expect(() => validator.validateFinding(finding({ line: 1 }))).toThrow(/not a changed line/u);
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
