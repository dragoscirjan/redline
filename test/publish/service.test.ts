import { describe, expect, it } from 'vitest';
import { PublicationService } from '../../src/publish/service.js';
import type { FileReviewPublication, ReviewPublisher, ReviewScope } from '../../src/publish/types.js';
import type { FileReviewRecord, ReviewRunSummary } from '../../src/review/types.js';

const HEAD = 'b'.repeat(40);
const SCOPE: ReviewScope = { repository: 'owner/repository', pullRequest: 14, head: HEAD };

interface FakePublisherCalls {
  currentHead: number;
  publishFileReview: number;
  upsertSummary: number;
}

function fakePublisher(options: { head?: string; publishError?: Error } = {}): {
  publisher: ReviewPublisher;
  calls: FakePublisherCalls;
  publications: FileReviewPublication[];
} {
  const calls: FakePublisherCalls = { currentHead: 0, publishFileReview: 0, upsertSummary: 0 };
  const publications: FileReviewPublication[] = [];
  const publisher: ReviewPublisher = {
    async currentHead() {
      calls.currentHead += 1;
      return options.head ?? SCOPE.head;
    },
    async upsertSummary(_scope, _body, marker) {
      calls.upsertSummary += 1;
      return marker.includes('summary') ? 100 : 101;
    },
    async publishFileReview(_scope, publication) {
      calls.publishFileReview += 1;
      publications.push(publication);
      if (options.publishError) throw options.publishError;
      return 30 + calls.publishFileReview;
    },
  };
  return { publisher, calls, publications };
}

function record(overrides: Partial<FileReviewRecord> = {}): FileReviewRecord {
  return {
    version: 2,
    fileId: '000001',
    path: 'src/example.ts',
    status: 'M',
    harness: 'pi',
    model: 'test-model',
    outcome: 'findings',
    findings: [
      {
        id: 'f-1',
        category: 'correctness',
        classification: 'defect',
        severity: 'high',
        confidence: 0.9,
        side: 'RIGHT',
        startLine: 3,
        endLine: 3,
        evidence: 'evidence',
        impact: 'impact',
        fix: 'fix',
        fixPrompt: 'fix prompt',
      },
    ],
    durationMs: 10,
    ...overrides,
  };
}

function summary(overrides: Partial<ReviewRunSummary> = {}): ReviewRunSummary {
  return {
    version: 2,
    harness: 'pi',
    model: 'test-model',
    provider: 'test',
    findingScope: 'defects',
    base: 'a'.repeat(40),
    head: HEAD,
    manifestFiles: 1,
    reviewedFiles: 1,
    omittedFiles: 0,
    findings: 1,
    files: [{ fileId: '000001', path: 'src/example.ts', outcome: 'findings', findingCount: 1, findingSpans: ['3-3'] }],
    ...overrides,
  };
}

describe('PublicationService', () => {
  it('publishes one review per file with findings plus the summary', async () => {
    const { publisher, calls, publications } = fakePublisher();
    const service = new PublicationService(publisher, SCOPE);
    const outcome = await service.publish([record()], summary());

    expect(calls.currentHead).toBe(1);
    expect(calls.publishFileReview).toBe(1);
    expect(calls.upsertSummary).toBe(1);
    expect(outcome.publishedFileReviews).toBe(1);
    expect(outcome.failedFileReviews).toBe(0);
    expect(outcome.files[0]).toMatchObject({ fileId: '000001', status: 'published', reviewId: 31, publishedComments: 1 });
    expect(publications[0]?.comments[0]?.path).toBe('src/example.ts');
    expect(publications[0]?.body).toContain('redline:file:v1');
  });

  it('publishes only the summary when every file is clean', async () => {
    const { publisher, calls } = fakePublisher();
    const service = new PublicationService(publisher, SCOPE);
    const outcome = await service.publish([record({ outcome: 'clean', findings: [] })], summary({ findings: 0 }));

    expect(calls.publishFileReview).toBe(0);
    expect(calls.upsertSummary).toBe(1);
    expect(outcome.files).toHaveLength(0);
    expect(outcome.publishedFileReviews).toBe(0);
  });

  it('aborts before publishing when the pull request head moved', async () => {
    const { publisher, calls } = fakePublisher({ head: 'c'.repeat(40) });
    const service = new PublicationService(publisher, SCOPE);
    await expect(service.publish([record()], summary())).rejects.toThrow(/head changed/u);
    expect(calls.publishFileReview).toBe(0);
    expect(calls.upsertSummary).toBe(0);
  });

  it('records per-file failures without blocking later files', async () => {
    const { publisher, calls } = fakePublisher();
    let attempts = 0;
    const failing: ReviewPublisher = {
      ...publisher,
      async publishFileReview() {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
        return 32;
      },
    };
    const service = new PublicationService(failing, SCOPE);
    const outcome = await service.publish([record(), record({ fileId: '000002', path: 'src/other.ts' })], summary({ findings: 2 }));

    expect(calls.upsertSummary).toBe(1);
    expect(outcome.publishedFileReviews).toBe(1);
    expect(outcome.failedFileReviews).toBe(1);
    expect(outcome.failedInlineComments).toBe(1);
    expect(outcome.files[0]).toMatchObject({ status: 'failed', reason: 'boom' });
    expect(outcome.files[1]).toMatchObject({ status: 'published' });
  });

  it('caps file reviews and inline comments', async () => {
    const { publisher, publications } = fakePublisher();
    const service = new PublicationService(publisher, SCOPE);
    const many = Array.from({ length: 30 }, (_value, index) =>
      record({ fileId: String(index + 1).padStart(6, '0'), path: `src/file-${index}.ts` }),
    );
    const outcome = await service.publish(many, summary());

    expect(publications).toHaveLength(25);
    expect(outcome.publishedFileReviews).toBe(25);
    expect(outcome.files.filter((entry) => entry.status === 'skipped')).toHaveLength(5);
    // 100-comment budget shared across files: one comment per file until exhausted.
    const totalComments = publications.reduce((total, publication) => total + publication.comments.length, 0);
    expect(totalComments).toBeLessThanOrEqual(100);
  });

  it('respects the remaining comment budget when a file has many findings', async () => {
    const { publisher, publications } = fakePublisher();
    const service = new PublicationService(publisher, SCOPE);
    const spread = Array.from({ length: 12 }, (_value, index) =>
      record({
        fileId: String(index + 1).padStart(6, '0'),
        path: `src/file-${index}.ts`,
        findings: Array.from({ length: 12 }, (_unused, findingIndex) => ({
          id: `f-${index}-${findingIndex}`,
          category: 'correctness',
          classification: 'defect',
          severity: 'low',
          confidence: 0.5,
          side: 'RIGHT' as const,
          startLine: findingIndex + 1,
          endLine: findingIndex + 1,
          evidence: 'evidence',
          impact: 'impact',
          fix: 'fix',
          fixPrompt: 'fix prompt',
        })),
      }),
    );
    const outcome = await service.publish(spread, summary());

    const totalComments = publications.reduce((total, publication) => total + publication.comments.length, 0);
    expect(totalComments).toBe(100);
    // Eight files publish their full 12 findings, the ninth gets the last 4
    // budgeted comments, and the remaining files are skipped by the cap.
    expect(publications[0]?.comments).toHaveLength(12);
    expect(publications[8]?.comments).toHaveLength(4);
    expect(outcome.publishedFileReviews).toBe(9);
    expect(outcome.files.filter((entry) => entry.status === 'skipped')).toHaveLength(3);
  });
});
