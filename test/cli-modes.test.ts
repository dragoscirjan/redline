import { describe, expect, it } from 'vitest';
import { main } from '../src/review/cli.js';
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
      expect(calls.bodies[0]).toContain('Redline review summary');
    } finally {
      await fixture.cleanup();
    }
  });

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
