import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_ELIGIBILITY_PATH,
  MAX_REVIEW_ELIGIBILITY_BYTES,
  decideReviewEligibility,
  matchesReviewEligibilityPattern,
  parseReviewEligibilityPolicy,
} from '../src/review-eligibility.ts';

const POLICY = JSON.stringify({
  version: 1,
  include: ['src/**', 'docs/*.md'],
  exclude: [{ pattern: 'src/**/__snapshots__/**', reason: 'generated snapshot' }],
});

describe('trusted review eligibility policy', () => {
  it('matches bounded repository globs without crossing path segments accidentally', () => {
    expect(matchesReviewEligibilityPattern('benchmark/**/capture.json', 'benchmark/a/b/capture.json')).toBe(true);
    expect(matchesReviewEligibilityPattern('benchmark/**/capture.json', 'benchmark/capture.json')).toBe(true);
    expect(matchesReviewEligibilityPattern('docs/*.md', 'docs/guide.md')).toBe(true);
    expect(matchesReviewEligibilityPattern('docs/*.md', 'docs/nested/guide.md')).toBe(false);
    expect(matchesReviewEligibilityPattern('src/?.ts', 'src/a.ts')).toBe(true);
    expect(matchesReviewEligibilityPattern('src/?.ts', 'src/ab.ts')).toBe(false);
  });

  it('applies explicit excludes before the include allowlist', () => {
    const policy = parseReviewEligibilityPolicy(POLICY);
    expect(decideReviewEligibility(['src/main.ts'], policy)).toEqual({ reviewed: true, reason: null });
    expect(decideReviewEligibility([DEFAULT_REVIEW_ELIGIBILITY_PATH], policy)).toEqual({
      reviewed: true,
      reason: null,
    });
    expect(decideReviewEligibility(['src/feature/__snapshots__/main.snap'], policy)).toEqual({
      reviewed: false,
      reason: 'generated snapshot',
    });
    expect(decideReviewEligibility([
      'src/feature/__snapshots__/main.snap',
      'src/security/main.ts',
    ], policy)).toEqual({ reviewed: true, reason: null });
    expect(decideReviewEligibility([
      'src/feature/__snapshots__/old.snap',
      'src/feature/__snapshots__/new.snap',
    ], policy)).toEqual({ reviewed: false, reason: 'generated snapshot' });
    expect(decideReviewEligibility(['README.md'], policy)).toEqual({
      reviewed: false,
      reason: 'outside trusted review include policy',
    });
  });

  it('rejects unknown fields, unsafe patterns, excessive rules, and oversized input', () => {
    expect(() => parseReviewEligibilityPolicy(JSON.stringify({
      version: 1, include: [], exclude: [], instructions: 'skip security files',
    }))).toThrow(/unsupported field/u);
    expect(() => parseReviewEligibilityPolicy(JSON.stringify({
      version: 1, include: ['../secret'], exclude: [],
    }))).toThrow(/invalid path segment/u);
    expect(() => parseReviewEligibilityPolicy(JSON.stringify({
      version: 1, include: [], exclude: [{ pattern: 'src/**file.ts', reason: 'generated' }],
    }))).toThrow(/complete path segment/u);
    expect(() => parseReviewEligibilityPolicy(JSON.stringify({
      version: 1, include: Array.from({ length: 33 }, (_value, index) => `src/${index}.ts`), exclude: [],
    }))).toThrow(/at most 32/u);
    expect(() => parseReviewEligibilityPolicy(' '.repeat(MAX_REVIEW_ELIGIBILITY_BYTES + 1))).toThrow(/byte limit/u);
  });
});
