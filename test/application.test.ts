import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CompositeReporter, ReviewApplication, type ReviewReporter } from '../src/application/review.ts';
import { requireCapability } from '../src/application/capabilities.ts';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.ts';

function reporter(id: string): ReviewReporter {
  return { id, preflight: vi.fn(async () => {}), progress: vi.fn(), complete: vi.fn(async () => {}) };
}

describe('portable review application', () => {
  it('preserves artifacts despite a failed reporter and emits content-free events', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo')).review!;
      const bad = reporter('bad');
      bad.complete = vi.fn(async () => { throw new Error('reporter failed'); });
      const good = reporter('good');
      const composite = new CompositeReporter([bad, good]);
      const dispose = vi.fn(async () => {});
      const application = new ReviewApplication({
        source: { capture: async () => ({ reviewDirectory: fixture.review, sourceDirectory: fixture.source, dispose }) },
        reporter: composite,
      });
      const result = await application.run({ environment }, new AbortController().signal);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(await readFile(join(fixture.output, 'reviews/summary.json'), 'utf8'))).toEqual(result.summary);
      expect(good.complete).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect([...composite.failures]).toEqual(['bad']);
      expect(good.progress).toHaveBeenCalledWith({ kind: 'file-completed', fileId: '000001', outcome: 'clean' });
    } finally { await fixture.cleanup(); }
  });

  it('preflights before capture and cleans up execution failures', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo')).review!;
      const bad = reporter('bad');
      bad.preflight = async () => { throw new Error('preflight'); };
      const capture = vi.fn();
      await expect(new ReviewApplication({ source: { capture }, reporter: new CompositeReporter([bad]) })
        .run({ environment }, new AbortController().signal)).rejects.toThrow('preflight');
      expect(capture).not.toHaveBeenCalled();
      const dispose = vi.fn(async () => {});
      await expect(new ReviewApplication({
        source: { capture: async () => ({ reviewDirectory: fixture.review, sourceDirectory: fixture.source, dispose }) },
        reporter: new CompositeReporter([]), execute: async () => { throw new Error('execution'); },
      }).run({ environment }, new AbortController().signal)).rejects.toThrow('execution');
      expect(dispose).toHaveBeenCalledOnce();
    } finally { await fixture.cleanup(); }
  });

  it('distinguishes planned capabilities from unknown IDs and never falls back', () => {
    expect(() => requireCapability('vcs', 'git')).not.toThrow();
    for (const id of ['jj', 'mercurial']) expect(() => requireCapability('vcs', id)).toThrow('not implemented');
    expect(() => requireCapability('reporter', 'github')).toThrow('not implemented');
    expect(() => requireCapability('vcs', 'arbitrary-plugin')).toThrow('unknown');
  });
});
