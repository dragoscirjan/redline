import { describe, expect, it } from 'vitest';
import { main } from '../src/review/cli.js';
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
});
