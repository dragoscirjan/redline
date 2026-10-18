import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/review/cli.js';
import { loadPublishedRun } from '../src/review/run-output.js';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.js';

const HEAD = 'b'.repeat(40);

function fakePublisher(head = HEAD): {
  publisher: import('../src/publish/index.js').ReviewPublisher;
  calls: { currentHead: number; publishFileReview: number; upsertSummary: number; bodies: string[] };
} {
  const calls = { currentHead: 0, publishFileReview: 0, upsertSummary: 0, bodies: [] as string[] };
  const publisher: import('../src/publish/index.js').ReviewPublisher = {
    async currentHead() {
      calls.currentHead += 1;
      return head;
    },
    async upsertSummary(_scope, body) {
      calls.upsertSummary += 1;
      calls.bodies.push(body);
      return 100;
    },
    async publishFileReview() {
      calls.publishFileReview += 1;
      return 30;
    },
  };
  return { publisher, calls };
}

function announceEnvironment(): NodeJS.ProcessEnv {
  return {
    REDLINE_HARNESS: 'pi',
    REDLINE_MODEL_CONFIG: JSON.stringify({ provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', model: 'test-model' }),
    REDLINE_PUBLISH_TOKEN: 'gh-token',
    REDLINE_REPOSITORY: 'owner/repository',
    REDLINE_PULL_REQUEST: '14',
    REDLINE_HEAD: HEAD,
  };
}

describe('single-purpose CLI modes', () => {
  it('rejects combined or unknown modes', async () => {
    expect(await main(['--announce-only', '--publish-only'], {})).toBe(2);
    expect(await main(['--nonsense'], {})).toBe(2);
  });

  it('announces the review start', async () => {
    const { publisher, calls } = fakePublisher();
    const exit = await main(['--announce-only'], announceEnvironment(), { publisher });
    expect(exit).toBe(0);
    expect(calls.upsertSummary).toBe(1);
    expect(calls.bodies[0]).toContain('Redline review in progress');
  });

  it('continues with exit 0 when the announce step fails', async () => {
    const { publisher, calls } = fakePublisher('c'.repeat(40)); // stale head
    const exit = await main(['--announce-only'], announceEnvironment(), { publisher });
    expect(exit).toBe(1);
    expect(calls.upsertSummary).toBe(0);
  });

  it('announces the failure state with a bounded reason', async () => {
    const { publisher, calls } = fakePublisher();
    const exit = await main(['--announce-failure'], { ...announceEnvironment(), REDLINE_FAILURE_REASON: `boom ${'gh-token'}` }, { publisher });
    expect(exit).toBe(0);
    expect(calls.bodies[0]).toContain('Redline review failed');
    expect(calls.bodies[0]).toContain('boom');
    expect(calls.bodies[0]).not.toContain('gh-token');
    expect(calls.bodies[0]).toContain('[redacted]');
  });

  it('publishes the written run from disk', async () => {
    const fixture = await createBundleFixture();
    try {
      // Run the review first (echo harness writes records into the output dir).
      const reviewEnv = cleanReviewEnvironment(fixture, 'echo');
      expect(await main([], reviewEnv)).toBe(0);

      const { publisher, calls } = fakePublisher();
      const exit = await main(
        ['--publish-only'],
        {
          REDLINE_OUTPUT_DIR: reviewEnv.REDLINE_OUTPUT_DIR ?? '',
          REDLINE_PUBLISH_TOKEN: 'gh-token',
          REDLINE_REPOSITORY: 'owner/repository',
          REDLINE_PULL_REQUEST: '14',
          REDLINE_HEAD: HEAD,
        },
        { publisher },
      );
      expect(exit).toBe(0);
      expect(calls.upsertSummary).toBe(1);
      // The fixture review is clean: no file reviews requested.
      expect(calls.publishFileReview).toBe(0);
      expect(calls.bodies[0]).toContain('Redline pull request review');
    } finally {
      await fixture.cleanup();
    }
  });

  it('migrates a non-verified legacy v1 review for publish-only', async () => {
    const fixture = await createBundleFixture();
    try {
      const reviewEnv = cleanReviewEnvironment(fixture, 'echo');
      expect(await main([], reviewEnv)).toBe(0);
      const path = join(fixture.output, 'reviews', 'review.json');
      const review = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      review.version = 1;
      await writeFile(path, JSON.stringify(review));
      const loaded = await loadPublishedRun(fixture.output);
      expect(loaded.review.version).toBe(2);
      const { publisher, calls } = fakePublisher();
      expect(await main(['--publish-only'], {
        REDLINE_OUTPUT_DIR: fixture.output,
        REDLINE_PUBLISH_TOKEN: 'gh-token', REDLINE_REPOSITORY: 'owner/repository',
        REDLINE_PULL_REQUEST: '14', REDLINE_HEAD: HEAD,
      }, { publisher })).toBe(0);
      expect(calls.upsertSummary).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['review coverage', 'file verification'] as const)(
    'rejects a verified legacy v1 review marked by %s before publication', async (marker) => {
      const fixture = await createBundleFixture();
      try {
        const reviewEnv = cleanReviewEnvironment(fixture, 'echo');
        expect(await main([], reviewEnv)).toBe(0);
        const path = join(fixture.output, 'reviews', 'review.json');
        const review = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        review.version = 1;
        if (marker === 'review coverage') {
          const coverage = review.coverage as Record<string, unknown>;
          coverage.verification = { status: 'completed', required: true };
          await writeFile(path, JSON.stringify(review));
        } else {
          await writeFile(path, JSON.stringify(review));
          const recordPath = join(fixture.output, 'reviews', '000001.json');
          const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
          record.verification = { status: 'not-applicable', requested: 0, accepted: 0,
            rejected: 0, durationMs: 0 };
          await writeFile(recordPath, JSON.stringify(record));
        }
        await expect(loadPublishedRun(fixture.output)).rejects.toThrow(/verified legacy v1 review/u);
        const { publisher, calls } = fakePublisher();
        expect(await main(['--publish-only'], {
          REDLINE_OUTPUT_DIR: fixture.output,
          REDLINE_PUBLISH_TOKEN: 'gh-token', REDLINE_REPOSITORY: 'owner/repository',
          REDLINE_PULL_REQUEST: '14', REDLINE_HEAD: HEAD,
        }, { publisher })).toBe(1);
        expect(calls).toMatchObject({ currentHead: 0, publishFileReview: 0, upsertSummary: 0 });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('fails when the output directory has no run', async () => {
    const { publisher } = fakePublisher();
    const exit = await main(
      ['--publish-only'],
      {
        REDLINE_OUTPUT_DIR: '/nonexistent/redline-output',
        REDLINE_PUBLISH_TOKEN: 'gh-token',
        REDLINE_REPOSITORY: 'owner/repository',
        REDLINE_PULL_REQUEST: '14',
        REDLINE_HEAD: HEAD,
      },
      { publisher },
    );
    expect(exit).toBe(1);
  });

  it('rejects a saved run that belongs to another head', async () => {
    const fixture = await createBundleFixture();
    try {
      const reviewEnv = cleanReviewEnvironment(fixture, 'echo');
      expect(await main([], reviewEnv)).toBe(0);
      const { publisher, calls } = fakePublisher();
      const exit = await main(
        ['--publish-only'],
        {
          REDLINE_OUTPUT_DIR: reviewEnv.REDLINE_OUTPUT_DIR ?? '',
          REDLINE_PUBLISH_TOKEN: 'gh-token',
          REDLINE_REPOSITORY: 'owner/repository',
          REDLINE_PULL_REQUEST: '14',
          REDLINE_HEAD: 'c'.repeat(40), // Not the run's head.
        },
        { publisher },
      );
      expect(exit).toBe(1);
      expect(calls.upsertSummary).toBe(0);
      expect(calls.publishFileReview).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });
});
