import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReviewWriter } from '../src/review/writer.js';
import type { FileReviewRecord, ReviewRunSummary } from '../src/review/types.js';

describe('createReviewWriter', () => {
  it('writes JSON and Markdown records plus the summary', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const output = await mkdtemp(join(tmpdir(), 'redline-writer-'));
    try {
      const writer = createReviewWriter(output);
      const record: FileReviewRecord = {
        version: 1,
        fileId: '000001',
        path: 'src/example.ts',
        status: 'M',
        harness: 'echo',
        model: 'test-model',
        outcome: 'findings',
        findings: [
          {
            id: 'f-abc',
            category: 'correctness',
            classification: 'defect',
            severity: 'high',
            confidence: 0.9,
            side: 'RIGHT',
            line: 2,
            evidence: 'new line',
            impact: 'Wrong value returned.',
            fix: 'Restore the guard.',
          },
        ],
        durationMs: 5,
      };
      await writer.writeFileReview({ ...record, rawModelOutput: 'x'.repeat(20 * 1024) });
      const json = JSON.parse(await readFile(join(output, 'reviews', '000001.json'), 'utf8')) as FileReviewRecord & {
        rawModelOutput?: string;
      };
      expect(json.outcome).toBe('findings');
      expect(json.findings).toHaveLength(1);
      // Raw model output is bounded for the artifact.
      expect((json.rawModelOutput ?? '').length).toBeLessThanOrEqual(16 * 1024);

      const markdown = await readFile(join(output, 'reviews', '000001.md'), 'utf8');
      expect(markdown).toContain('# Review: src/example.ts');
      expect(markdown).toContain('### Finding 1: high defect (correctness)');
      expect(markdown).toContain('`new line`');

      const summary: ReviewRunSummary = {
        version: 1,
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
        files: [{ fileId: '000001', path: 'src/example.ts', outcome: 'findings', findingCount: 1 }],
      };
      await writer.writeSummary(summary);
      const summaryJson = JSON.parse(await readFile(join(output, 'reviews', 'summary.json'), 'utf8')) as ReviewRunSummary;
      expect(summaryJson.findings).toBe(1);
      const summaryMarkdown = await readFile(join(output, 'reviews', 'summary.md'), 'utf8');
      expect(summaryMarkdown).toContain('# Review run summary');
      expect(summaryMarkdown).toContain('| src/example.ts | findings | 1 |');
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
