import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadReviewBundle } from '../src/review/bundle.js';
import { parseChangedLines } from '../src/review/report.js';
import {
  buildRemediation,
  formatSpan,
  MAX_SPAN_LINES,
  renderFixPrompt,
  resolveSpanLines,
  spanLocation,
} from '../src/review/remediation.js';
import type { ValidatedFinding } from '../src/review/types.js';
import { createBundleFixture } from './helpers/bundle.js';

const MULTI_LINE_DIFF =
  'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,4 +1,4 @@\n context\n-old1\n-old2\n+new1\n+new2\n ctx2\n';

function validatedFinding(overrides: Partial<ValidatedFinding> = {}): ValidatedFinding {
  return {
    category: 'correctness',
    classification: 'defect',
    severity: 'high',
    confidence: 0.9,
    side: 'RIGHT',
    startLine: 2,
    endLine: 3,
    evidence: 'new1',
    impact: 'Wrong result.',
    fix: 'Restore the guard.',
    id: 'f-abc123',
    ...overrides,
  };
}

describe('span formatting', () => {
  it('renders single lines and ranges', () => {
    expect(formatSpan(2, 2)).toBe('2');
    expect(formatSpan(2, 5)).toBe('2-5');
    expect(spanLocation('src/example.ts', 2, 5)).toBe('src/example.ts:2-5');
    expect(spanLocation('src/example.ts', 7, 7)).toBe('src/example.ts:7');
  });
});

describe('resolveSpanLines', () => {
  it('resolves spans covered by the diff without file access', async () => {
    const fixture = await createBundleFixture({ diff: MULTI_LINE_DIFF });
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const changed = parseChangedLines(MULTI_LINE_DIFF, file.diffFile);
      // Lines 1..4: context(1), changed(2,3), context(4) — all in the diff.
      const lines = await resolveSpanLines(bundle, file, 'RIGHT', 1, 4, changed);
      expect(lines).toEqual(['context', 'new1', 'new2', 'ctx2']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('resolves spans beyond the diff from the head file', async () => {
    const fixture = await createBundleFixture({
      headContent: 'new\nl3\nl4\nl5\n',
    });
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const changed = parseChangedLines(
        'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
        file.diffFile,
      );
      // Line 1 is changed; lines 2-4 exist only in the head file.
      const lines = await resolveSpanLines(bundle, file, 'RIGHT', 1, 4, changed);
      expect(lines).toEqual(['new', 'l3', 'l4', 'l5']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('resolves left-side spans from the base file when the diff is exhausted', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.review, 'base-files', '000001'), 'old\nbase2\nbase3\n');
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const changed = parseChangedLines(
        'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
        file.diffFile,
      );
      const lines = await resolveSpanLines(bundle, file, 'LEFT', 1, 3, changed);
      expect(lines).toEqual(['old', 'base2', 'base3']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns undefined for spans it cannot resolve', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const changed = parseChangedLines(
        'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
        file.diffFile,
      );
      // Beyond the head file's length: neither the diff nor the file covers it.
      expect(await resolveSpanLines(bundle, file, 'RIGHT', 1, 99, changed)).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses spans above the line cap without reading anything', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const changed = parseChangedLines('', file.diffFile);
      expect(
        await resolveSpanLines(bundle, file, 'RIGHT', 1, MAX_SPAN_LINES + 1, changed),
      ).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('renderFixPrompt', () => {
  it('embeds the location, finding, span content, and rules', () => {
    const prompt = renderFixPrompt(validatedFinding(), 'src/example.ts', ['new1', 'new2']);
    expect(prompt).toContain('Location: src/example.ts:2-3 (side RIGHT: the new version of the file)');
    expect(prompt).toContain('Evidence (line 2): new1');
    expect(prompt).toContain('Impact: Wrong result.');
    expect(prompt).toContain('Fix guidance from the review: Restore the guard.');
    expect(prompt).toContain('  2 | new1');
    expect(prompt).toContain('  3 | new2');
    expect(prompt).toContain('untrusted review data');
    expect(prompt).toContain('Rules:');
  });

  it('notes unresolvable spans and missing proposals', () => {
    const prompt = renderFixPrompt(validatedFinding(), 'src/example.ts', undefined);
    expect(prompt).toContain('not resolvable from the review bundle');
    expect(prompt).toContain('none proposed by the review');
  });
});

describe('buildRemediation', () => {
  it('renders a suggestion from the span and the proposed change', async () => {
    const fixture = await createBundleFixture({ diff: MULTI_LINE_DIFF });
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const changed = parseChangedLines(MULTI_LINE_DIFF, file.diffFile);
      const remediation = await buildRemediation(
        bundle,
        file,
        validatedFinding({ suggestedChange: 'fixed1\nfixed2' }),
        changed,
      );
      expect(remediation.suggestion).toBe('-new1\n-new2\n+fixed1\n+fixed2');
      expect(remediation.fixPrompt).toContain('Location: src/example.ts:2-3');
      expect(remediation.fixPrompt).toContain('fixed1');
    } finally {
      await fixture.cleanup();
    }
  });

  it('drops suggestions that change nothing', async () => {
    const fixture = await createBundleFixture({ diff: MULTI_LINE_DIFF });
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const changed = parseChangedLines(MULTI_LINE_DIFF, file.diffFile);
      const remediation = await buildRemediation(
        bundle,
        file,
        validatedFinding({ suggestedChange: 'new1\nnew2' }),
        changed,
      );
      expect(remediation.suggestion).toBeUndefined();
      expect(remediation.fixPrompt).toContain('new1');
    } finally {
      await fixture.cleanup();
    }
  });

  it('always produces a fix prompt, with or without a proposal or span', async () => {
    const fixture = await createBundleFixture({ diff: MULTI_LINE_DIFF });
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const changed = parseChangedLines(MULTI_LINE_DIFF, file.diffFile);
      const withoutProposal = await buildRemediation(bundle, file, validatedFinding(), changed);
      expect(withoutProposal.suggestion).toBeUndefined();
      expect(withoutProposal.fixPrompt).toContain('Fix one code-review finding.');
    } finally {
      await fixture.cleanup();
    }
  });
});
