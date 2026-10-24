import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReviewWriter } from '../src/review/writer.js';
import type { FileReviewRecord, PublishedFinding, ReviewRunSummary } from '../src/review/types.js';
import {
  publishedFinding as basePublishedFinding,
  pullRequestReview,
} from './helpers/finding.js';

const DISABLED_CONTEXT = {
  status: 'disabled' as const,
  provider: null,
  revision: null,
  relatedSpans: 0,
  sourceBytes: 0,
  reason: 'not-configured' as const,
};

const FIX_PROMPT = [
  'Fix one code-review finding.',
  '',
  'Location: src/example.ts:3-5 (side RIGHT: the new version of the file)',
].join('\n');

function publishedFinding(overrides: Partial<PublishedFinding> = {}): PublishedFinding {
  return basePublishedFinding({
    id: 'f-abc',
    title: 'Missing guard returns the wrong value',
    severity: 'high',
    startLine: 3,
    endLine: 5,
    evidence: 'const value = compute(input);',
    impact: 'Wrong value returned.',
    fix: 'Restore the guard.',
    suggestion: '-const value = compute(input);\n-context line\n+const value = guarded(input);',
    fixPrompt: FIX_PROMPT,
    ...overrides,
  });
}

describe('createReviewWriter', () => {
  it('writes JSON and Markdown records plus the summary', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const output = await mkdtemp(join(tmpdir(), 'redline-writer-'));
    try {
      const writer = createReviewWriter(output);
      const record: FileReviewRecord = {
        version: 4,
        fileId: '000001',
        path: 'src/example.ts',
        status: 'M',
        harness: 'echo',
        model: 'test-model',
        codeContext: DISABLED_CONTEXT,
        outcome: 'findings',
        findings: [publishedFinding()],
        rejectedCandidates: [],
        durationMs: 5,
      };
      await writer.writeFileReview({ ...record, rawModelOutput: 'x'.repeat(20 * 1024) });
      const json = JSON.parse(await readFile(join(output, 'reviews', '000001.json'), 'utf8')) as {
        version: number;
        outcome: string;
        findings: Array<PublishedFinding & { suggestedChange?: unknown }>;
        rawModelOutput?: string;
      };
      expect(json.version).toBe(4);
      expect(json.outcome).toBe('findings');
      expect(json.findings).toHaveLength(1);
      expect(json.findings[0]?.startLine).toBe(3);
      expect(json.findings[0]?.endLine).toBe(5);
      expect(json.findings[0]?.suggestion).toBe(
        '-const value = compute(input);\n-context line\n+const value = guarded(input);',
      );
      expect(json.findings[0]?.fixPrompt).toBe(FIX_PROMPT);
      // The raw model proposal is not a published field.
      expect(json.findings[0]?.suggestedChange).toBeUndefined();
      // Raw model output is bounded for the artifact.
      expect((json.rawModelOutput ?? '').length).toBeLessThanOrEqual(16 * 1024);

      const markdown = await readFile(join(output, 'reviews', '000001.md'), 'utf8');
      expect(markdown).toContain('# Review: src/example.ts');
      expect(markdown).toContain('### Finding 1: Missing guard returns the wrong value');
      expect(markdown).toContain('- **Location:** src/example.ts:3-5 (side RIGHT)');
      expect(markdown).toContain('- **Evidence (line 3):** `const value = compute(input);`');
      expect(markdown).toContain('**Suggested change** for src/example.ts:3-5 (side RIGHT):');
      expect(markdown).toContain('```diff');
      expect(markdown).toContain('-const value = compute(input);');
      expect(markdown).toContain('+const value = guarded(input);');
      expect(markdown).toContain('**Fix prompt** for a coding agent:');
      expect(markdown).toContain('```text');
      expect(markdown).toContain('Fix one code-review finding.');

      const summary: ReviewRunSummary = {
        version: 3,
        harness: 'echo',
        model: 'test-model',
        provider: 'mock',
        findingScope: 'defects',
        base: 'a'.repeat(40),
        head: 'b'.repeat(40),
        manifestFiles: 1,
        reviewedFiles: 1,
        omittedFiles: 0,
        findings: 1,
        codeContext: { ...DISABLED_CONTEXT, filesWithContext: 0 },
        files: [
          {
            fileId: '000001',
            path: 'src/example.ts',
            outcome: 'findings',
            codeContext: DISABLED_CONTEXT,
            findingCount: 1,
            findingSpans: ['3-5'],
          },
        ],
      };
      await writer.writeSummary(summary);
      const summaryJson = JSON.parse(await readFile(join(output, 'reviews', 'summary.json'), 'utf8')) as {
        version: number;
        findings: number;
      };
      expect(summaryJson.version).toBe(3);
      expect(summaryJson.findings).toBe(1);
      const summaryMarkdown = await readFile(join(output, 'reviews', 'summary.md'), 'utf8');
      expect(summaryMarkdown).toContain('# Review run summary');
      expect(summaryMarkdown).toContain('| src/example.ts | findings | executed | 1 (3-5) | disabled (0 spans) |');

      const review = pullRequestReview({
        findings: [{ ...publishedFinding(), triggerFileId: '000001', triggerPath: 'src/example.ts' }],
        verdict: { status: 'blocked', reasons: ['f-abc: unresolved high defect'] },
      });
      await writer.writePullRequestReview(review);
      const reviewJson = JSON.parse(await readFile(join(output, 'reviews', 'review.json'), 'utf8')) as {
        version: number;
        verdict: { status: string };
        findings: unknown[];
        coverage: { files: { status: string } };
      };
      expect(reviewJson).toMatchObject({
        version: 2,
        verdict: { status: 'blocked' },
        coverage: { files: { status: 'completed' } },
      });
      expect(reviewJson.findings).toHaveLength(1);
      const reviewMarkdown = await readFile(join(output, 'reviews', 'review.md'), 'utf8');
      expect(reviewMarkdown).toContain('# Pull request review');
      expect(reviewMarkdown).toContain('- **Verdict:** blocked');
      expect(reviewMarkdown).toContain('- **Graph queries:** not-applicable');
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
