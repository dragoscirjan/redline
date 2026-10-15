import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgeLiveVerification } from '../src/benchmark/judge-live-verification.js';

const directory = resolve('benchmark/review-quality/verification-v1/live-model');

describe('independently judged live verifier capture', () => {
  it('replays every manual judgment against predeclared issue locations and blocks activation on recall loss', async () => {
    const report = await judgeLiveVerification();
    expect(report).toEqual(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')));
    expect(report['gate']).toMatchObject({ activationReady: false,
      recallRegressions: expect.arrayContaining(['cross-file-rate-limit/file-only',
        'cross-file-cache-collision/indexed-context']),
      cleanFalsePositiveRegressions: [],
    });
    expect(report['modes']).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'file-only', discoveryCredited: 2, verifiedCredited: 0 }),
      expect.objectContaining({ mode: 'indexed-context', discoveryCredited: 3, verifiedCredited: 0 }),
    ]));
  });

  it('rejects a human judgment claiming an issue at a non-predeclared location', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-live-judgment-'));
    try {
      for (const file of ['baseline-capture.json', 'extension-capture.json']) {
        await copyFile(join(directory, file), join(root, file));
      }
      const judgments = JSON.parse(await readFile(join(directory, 'judgments.json'), 'utf8')) as {
        judgments: { fixtureId: string; expectedIssueId: string | null }[];
      };
      const target = judgments.judgments.find((item) => item.fixtureId === 'cross-file-rate-limit');
      if (target === undefined) throw new Error('missing expected judgment fixture');
      target.expectedIssueId = 'cross-account-cache-collision';
      await writeFile(join(root, 'judgments.json'), JSON.stringify(judgments));
      await expect(judgeLiveVerification(root)).rejects.toThrow('predeclared authoritative diff location');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
