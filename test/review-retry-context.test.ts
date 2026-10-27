import { describe, expect, it } from 'vitest';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { buildFileContextPayload } from '../src/review/prompt.ts';
import { MAX_SOURCE_CONTEXT_BYTES_PER_SIDE, MAX_SOURCE_CONTEXT_FILE_BYTES } from '../src/review/source-context.ts';
import { createBundleFixture, HEAD_SHA } from './helpers/bundle.ts';

async function context(fixture: Awaited<ReturnType<typeof createBundleFixture>>, strategy: 'focused-v1' | 'retry-enriched-v1') {
  const bundle = await loadReviewBundle(fixture.review, fixture.source);
  const file = bundle.manifest.files[0];
  if (file === undefined) throw new Error('fixture file missing');
  return buildFileContextPayload(bundle, file, undefined, strategy);
}

describe('bounded immutable retry context', () => {
  it('widens large-file excerpts without losing initial coverage or exceeding the side cap', async () => {
    const lines = Array.from({ length: 2_400 }, (_, index) => index === 1_199 ? 'new\n' : `line ${index} ${'x'.repeat(24)}\n`);
    const f = await createBundleFixture({ headContent: lines.join(''),
      diff: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1200 +1200 @@\n-old\n+new\n' });
    try {
      const original = JSON.parse(await context(f, 'focused-v1')).sourceContext.head;
      const enriched = JSON.parse(await context(f, 'retry-enriched-v1')).sourceContext.head;
      expect(enriched.originalBytes).toBeGreaterThan(MAX_SOURCE_CONTEXT_BYTES_PER_SIDE);
      expect(enriched.embeddedBytes).toBeGreaterThan(original.embeddedBytes);
      expect(enriched.embeddedBytes).toBeLessThanOrEqual(MAX_SOURCE_CONTEXT_BYTES_PER_SIDE);
      expect(enriched.truncated).toBe(true);
      expect(enriched.revision).toBe(HEAD_SHA);
      for (const span of enriched.excerpts) expect(span.content).toBe(lines.slice(span.startLine - 1, span.endLine).join(''));
      for (const old of original.excerpts) expect(enriched.excerpts.some((span: { startLine: number; endLine: number }) => span.startLine <= old.startLine && span.endLine >= old.endLine)).toBe(true);
    } finally { await f.cleanup(); }
  });

  it('does not read oversized source or pretend it became complete on retry', async () => {
    const f = await createBundleFixture({ headContent: 'x'.repeat(MAX_SOURCE_CONTEXT_FILE_BYTES + 1) });
    try {
      const head = JSON.parse(await context(f, 'retry-enriched-v1')).sourceContext.head;
      expect(head.status).toBe('omitted');
      expect(head.reason).toContain('file byte limit');
      expect(head.excerpts).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it('retains original focused context when enrichment would exceed the complete payload cap', async () => {
    const f = await createBundleFixture({ headContent: ['new', ...Array.from({ length: 1_000 }, (_, index) => `line ${index} ${'x'.repeat(48)}`)].join('\n') + '\n',
      diff: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n' + ' '.repeat(460 * 1024) });
    try {
      const original = await context(f, 'focused-v1');
      const enriched = await context(f, 'retry-enriched-v1');
      expect(Buffer.byteLength(enriched)).toBeLessThanOrEqual(512 * 1024);
      expect(enriched).toBe(original);
    } finally { await f.cleanup(); }
  });
});
