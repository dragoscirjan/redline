import { describe, expect, it } from 'vitest';
import { main, type CliDependencies } from '../src/review/cli.js';
import type { ReviewPublisher } from '../src/publish/index.js';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.js';

describe('redline-review CLI', () => {
  it('rejects unsupported arguments', async () => {
    expect(await main(['--nonsense'])).toBe(2);
    expect(await main(['run'])).toBe(2);
  });

  it('validates the environment in validate-only mode', async () => {
    const fixture = await createBundleFixture();
    try {
      expect(await main(['--validate-only'], {})).toBe(0);
      expect(await main(['--validate-only'], cleanReviewEnvironment(fixture, 'echo'))).toBe(0);
      // Invalid optional inputs fail validation.
      expect(
        await main(['--validate-only'], { REDLINE_FINDING_SCOPE: 'all-the-things' }),
      ).toBe(2);
      // Partial review inputs fail validation.
      expect(await main(['--validate-only'], { REDLINE_HARNESS: 'pi' })).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs a review with the echo harness end to end', async () => {
    const fixture = await createBundleFixture();
    try {
      const exit = await main([], cleanReviewEnvironment(fixture, 'echo'));
      expect(exit).toBe(0);
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const summary = JSON.parse(
        await readFile(join(fixture.output, 'reviews', 'summary.json'), 'utf8'),
      ) as { mode?: string; reviewedFiles: number };
      expect(summary.reviewedFiles).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('prints context-only status without running a review', async () => {
    const exit = await main([], { REDLINE_FINDING_SCOPE: 'defects' });
    expect(exit).toBe(0);
  });

  it('exits 1 when the review bundle cannot be loaded', async () => {
    const fixture = await createBundleFixture();
    try {
      const broken = {
        ...cleanReviewEnvironment(fixture, 'echo'),
        REDLINE_REVIEW_DIR: '/nonexistent/redline-review-dir',
      };
      expect(await main([], broken)).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  describe('publication', () => {
    const HEAD = 'b'.repeat(40);

    function fakePublisher(head = HEAD): {
      publisher: ReviewPublisher;
      calls: { currentHead: number; publishFileReview: number; upsertSummary: number };
    } {
      const calls = { currentHead: 0, publishFileReview: 0, upsertSummary: 0 };
      const publisher: ReviewPublisher = {
        async currentHead() {
          calls.currentHead += 1;
          return head;
        },
        async upsertSummary() {
          calls.upsertSummary += 1;
          return 100;
        },
        async publishFileReview() {
          calls.publishFileReview += 1;
          return 30;
        },
      };
      return { publisher, calls };
    }

    function publicationEnvironment(fixture: Awaited<ReturnType<typeof createBundleFixture>>): NodeJS.ProcessEnv {
      return {
        ...cleanReviewEnvironment(fixture, 'echo'),
        REDLINE_PUBLISH_TOKEN: 'gh-token',
        REDLINE_REPOSITORY: 'owner/repository',
        REDLINE_PULL_REQUEST: '14',
        REDLINE_HEAD: HEAD,
      };
    }

    it('publishes the managed summary after a clean review', async () => {
      const fixture = await createBundleFixture();
      try {
        const { publisher, calls } = fakePublisher();
        const exit = await main([], publicationEnvironment(fixture), { publisher });
        expect(exit).toBe(0);
        expect(calls.publishFileReview).toBe(0);
        expect(calls.upsertSummary).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    });

    it('exits 1 when the head moved during the review', async () => {
      const fixture = await createBundleFixture();
      try {
        const { publisher, calls } = fakePublisher('c'.repeat(40));
        const exit = await main([], publicationEnvironment(fixture), { publisher });
        expect(exit).toBe(1);
        expect(calls.publishFileReview).toBe(0);
        expect(calls.upsertSummary).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    });

    it('validates publication inputs in validate-only mode', async () => {
      const fixture = await createBundleFixture();
      try {
        expect(await main(['--validate-only'], publicationEnvironment(fixture))).toBe(0);
        expect(
          await main(['--validate-only'], { ...publicationEnvironment(fixture), REDLINE_HEAD: 'short' }),
        ).toBe(2);
      } finally {
        await fixture.cleanup();
      }
    });
  });
});
