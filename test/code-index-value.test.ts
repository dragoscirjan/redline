import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCodeIndexValueReport,
  distribution,
  renderCodeIndexValueMarkdown,
} from '../src/benchmark/code-index-value.js';

const ROOT = resolve('benchmark/code-index-value/v1');

async function capture(): Promise<unknown> {
  return JSON.parse(await readFile(resolve(ROOT, 'capture.json'), 'utf8')) as unknown;
}

describe('code-index value report', () => {
  it('reproduces the checked-in JSON and Markdown reports', async () => {
    const report = buildCodeIndexValueReport(await capture());
    expect(report).toEqual(JSON.parse(await readFile(resolve(ROOT, 'report.json'), 'utf8')));
    expect(`${renderCodeIndexValueMarkdown(report)}\n`).toBe(await readFile(resolve(ROOT, 'report.md'), 'utf8'));
  });

  it('compares cold and warm paths for both providers on synthetic and real repositories', async () => {
    const report = buildCodeIndexValueReport(await capture());
    expect(report.repositoryClasses.map((item) => item.kind)).toEqual(['synthetic', 'real']);
    for (const repositoryClass of report.repositoryClasses) {
      expect(repositoryClass.providers.map((item) => item.id)).toEqual(['cgc', 'gitnexus']);
      for (const provider of repositoryClass.providers) {
        expect(provider.conditions.map((item) => item.condition)).toEqual(['cold', 'warm']);
        expect(provider.conditions.every((item) => item.samples === 3)).toBe(true);
        expect(provider.conditions[0]?.cacheHitRate).toBe(0);
        expect(provider.conditions[1]?.cacheHitRate).toBe(1);
        expect(provider.conditions[1]?.indexMs.p95NearestRank).toBe(0);
        expect(provider.conditions.every((item) => item.supportedFiles.p50NearestRank === 1)).toBe(true);
      }
      const cgc = repositoryClass.providers[0]!;
      const gitnexus = repositoryClass.providers[1]!;
      expect(cgc.conditions.every((item) => item.statuses.partial === 3)).toBe(true);
      expect(cgc.conditions.every((item) => item.relatedSpans.p95NearestRank === 0)).toBe(true);
      expect(cgc.conditions.every((item) => item.sourceBytes.p95NearestRank === 0)).toBe(true);
      expect(gitnexus.conditions.every((item) => item.statuses.complete === 3)).toBe(true);
      expect(gitnexus.conditions.every((item) => item.relatedSpans.p50NearestRank > 0)).toBe(true);
      expect(gitnexus.conditions.every((item) => item.sourceBytes.p50NearestRank > 0)).toBe(true);
    }
  });

  it('keeps provider capability, quality, licensing, and activation decisions separate', async () => {
    const report = buildCodeIndexValueReport(await capture());
    expect(report.followUp.providers.map((item) => item.status)).toEqual(['complete', 'complete']);
    expect(report.quality['liveModel']).toMatchObject({
      fileOnlyCreditedIssues: 2,
      indexedCreditedIssues: 2,
      promptBytesAdded: 1039,
    });
    expect(report.repositoryClasses[0]?.providers[1]?.license.id).toBe('PolyForm-Noncommercial-1.0.0');
    expect(report.recommendation).toMatchObject({
      defaultProvider: 'cgc',
      changeDefault: false,
      enableVerification: false,
    });
  });

  it('uses deterministic nearest-rank percentiles', () => {
    expect(distribution([5, 1, 4, 2, 3])).toEqual({
      samples: 5,
      minimum: 1,
      p50NearestRank: 3,
      p95NearestRank: 5,
      maximum: 5,
    });
  });

  it('rejects captures without both repository classes', async () => {
    const value = await capture() as { repositoryClasses: unknown[] };
    expect(() => buildCodeIndexValueReport({ ...value, repositoryClasses: value.repositoryClasses.slice(0, 1) }))
      .toThrow(/2 through 8 repository classes/u);
  });
});
