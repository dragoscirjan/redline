import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeContextGraphFactDigest } from '../src/code-context/artifact.js';
import { loadReviewBundle } from '../src/review/bundle.js';
import {
  codeContextForFile,
  loadReviewCodeContext,
  MAX_INDEXED_CONTEXT_SOURCE_BYTES_PER_FILE,
} from '../src/review/indexed-context.js';
import { BASE_SHA, createBundleFixture, HEAD_SHA } from './helpers/bundle.js';

const REPOSITORY = 'owner/repository';

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    provider: { id: 'cgc', version: '0.5.7' },
    repository: REPOSITORY,
    revision: HEAD_SHA,
    status: 'complete',
    files: [
      {
        changedPath: 'src/example.ts',
        status: 'complete',
        related: [
          {
            path: 'src/related.ts',
            startLine: 2,
            endLine: 3,
            reason: 'incoming CALLS relationship',
          },
        ],
      },
    ],
    diagnostics: [],
    timings: { installationMs: 1, restoreMs: 2, validationMs: 3, indexMs: 4, queryMs: 5, saveMs: null },
    ...overrides,
  };
}

async function writeArtifact(root: string, value: Record<string, unknown>): Promise<string> {
  const path = join(root, 'code-context.json');
  await writeFile(path, `${JSON.stringify(value)}\n`);
  return path;
}

describe('review indexed context', () => {
  it('resolves every related span from captured head source with provenance', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src', 'related.ts'), 'zero\none\ntwo\nthree\n');
      const path = await writeArtifact(fixture.root, artifact());
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const loaded = await loadReviewCodeContext(bundle, { path, repository: REPOSITORY });
      const selected = codeContextForFile(loaded, bundle.manifest.files[0]!);

      expect(loaded.coverage).toMatchObject({
        status: 'complete',
        filesWithContext: 1,
        relatedSpans: 1,
        cache: 'built',
        timings: { validationMs: 3, indexMs: 4, queryMs: 5 },
        diagnosticCodes: [],
      });
      expect(selected.coverage).toMatchObject({ status: 'complete', relatedSpans: 1 });
      expect(selected.prompt?.related).toEqual([
        {
          path: 'src/related.ts',
          startLine: 2,
          endLine: 3,
          reason: 'incoming CALLS relationship',
          provider: { id: 'cgc', version: '0.5.7' },
          revision: HEAD_SHA,
          status: 'complete',
          content: 'one\ntwo',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('exposes only source-resolved, action-produced graph facts', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src', 'related.ts'), 'zero\none\ntwo\nthree\n');
      const graphFact = {
        provider: 'cgc',
        providerVersion: '0.5.7',
        snapshotRevision: BASE_SHA,
        capability: 'related-spans',
        query: `related-span:sha256:${createHash('sha256')
          .update(JSON.stringify(['src/example.ts', 'src/related.ts', 2, 3]), 'utf8')
          .digest('hex')}`,
        relationship: 'incoming CALLS relationship',
        resolution: 'exact' as const,
      };
      const value = artifact({ baseRevision: BASE_SHA });
      const files = value['files'] as Array<Record<string, unknown>>;
      const related = files[0]?.['related'] as Array<Record<string, unknown>>;
      related[0]!['graphReference'] = {
        ...graphFact,
        graphFactDigest: codeContextGraphFactDigest(graphFact),
      };
      const path = await writeArtifact(fixture.root, value);
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const loaded = await loadReviewCodeContext(bundle, { path, repository: REPOSITORY });

      expect(loaded.graphSnapshotRevision).toBe(BASE_SHA);
      expect(loaded.graphFactDigests).toEqual(new Set([codeContextGraphFactDigest(graphFact)]));
      expect(codeContextForFile(loaded, bundle.manifest.files[0]!).prompt?.related[0]).toMatchObject({
        graphReference: { graphFactDigest: codeContextGraphFactDigest(graphFact) },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('degrades identity mismatches to explicit unavailable file-only coverage', async () => {
    const fixture = await createBundleFixture();
    try {
      const path = await writeArtifact(fixture.root, artifact({
        revision: 'c'.repeat(40),
        baseRevision: 'd'.repeat(40),
      }));
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const loaded = await loadReviewCodeContext(bundle, { path, repository: REPOSITORY });
      const selected = codeContextForFile(loaded, bundle.manifest.files[0]!);

      expect(loaded.coverage).toMatchObject({ status: 'unavailable', reason: 'identity-mismatch' });
      expect(selected.prompt).toBeUndefined();
      expect(selected.coverage).toMatchObject({ status: 'unavailable', reason: 'identity-mismatch' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('degrades a missing configured artifact without blocking file-only review', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const loaded = await loadReviewCodeContext(bundle, {
        path: join(fixture.root, 'missing-code-context.json'),
        repository: REPOSITORY,
      });

      expect(loaded.coverage).toMatchObject({ status: 'unavailable', reason: 'artifact-invalid' });
      expect(codeContextForFile(loaded, bundle.manifest.files[0]!).prompt).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects symlinked related source without blocking file-only review', async () => {
    const fixture = await createBundleFixture();
    try {
      const outside = join(fixture.root, 'outside.ts');
      await writeFile(outside, 'outside\n');
      await symlink(outside, join(fixture.source, 'src', 'related.ts'));
      const path = await writeArtifact(fixture.root, artifact());
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const loaded = await loadReviewCodeContext(bundle, { path, repository: REPOSITORY });

      expect(loaded.coverage).toMatchObject({ status: 'unavailable', reason: 'artifact-invalid' });
      expect(codeContextForFile(loaded, bundle.manifest.files[0]!).prompt).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not spend review context limits on files excluded by the bundle', async () => {
    const fixture = await createBundleFixture();
    try {
      const manifestPath = join(fixture.review, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: Array<Record<string, unknown>> };
      manifest.files.push({
        id: '000002',
        status: 'A',
        oldPath: null,
        newPath: 'src/aaa-generated.ts',
        similarity: null,
        additions: 1,
        deletions: 0,
        binary: false,
        reviewed: false,
        diffFile: 'diffs/000002.diff',
        baseFile: null,
      });
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(join(fixture.review, 'diffs', '000002.diff'), '--- /dev/null\n+++ b/src/aaa-generated.ts\n@@ -0,0 +1 @@\n+generated\n');
      await writeFile(join(fixture.source, 'src', 'aaa-generated.ts'), 'generated\n');
      await writeFile(join(fixture.source, 'src', 'large-related.ts'), `${'x'.repeat(30 * 1024)}\n`);
      await writeFile(join(fixture.source, 'src', 'related.ts'), 'reviewed context\n');
      const value = artifact({
        files: [
          {
            changedPath: 'src/aaa-generated.ts',
            status: 'complete',
            related: [{ path: 'src/large-related.ts', startLine: 1, endLine: 1, reason: 'generated relationship' }],
          },
          {
            changedPath: 'src/example.ts',
            status: 'complete',
            related: [{ path: 'src/related.ts', startLine: 1, endLine: 1, reason: 'reviewed relationship' }],
          },
        ],
      });
      const path = await writeArtifact(fixture.root, value);
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const loaded = await loadReviewCodeContext(bundle, { path, repository: REPOSITORY });
      const selected = codeContextForFile(loaded, bundle.manifest.files[0]!);

      expect(loaded.coverage).toMatchObject({
        status: 'complete',
        filesWithContext: 1,
        relatedSpans: 1,
        sourceBytes: Buffer.byteLength('reviewed context'),
      });
      expect(selected.prompt?.related[0]?.content).toBe('reviewed context');
    } finally {
      await fixture.cleanup();
    }
  });

  it('applies the per-file source-byte limit deterministically', async () => {
    const fixture = await createBundleFixture();
    try {
      await mkdir(join(fixture.source, 'src'), { recursive: true });
      const line = 'x'.repeat(Math.ceil(MAX_INDEXED_CONTEXT_SOURCE_BYTES_PER_FILE / 6));
      await writeFile(join(fixture.source, 'src', 'related.ts'), `${Array.from({ length: 7 }, () => line).join('\n')}\n`);
      const oversized = artifact();
      const files = oversized['files'] as Array<Record<string, unknown>>;
      const related = files[0]!['related'] as Array<Record<string, unknown>>;
      related[0] = { ...related[0], startLine: 1, endLine: 7 };
      const path = await writeArtifact(fixture.root, oversized);
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const first = await loadReviewCodeContext(bundle, { path, repository: REPOSITORY });
      const second = await loadReviewCodeContext(bundle, { path, repository: REPOSITORY });

      expect(first.coverage).toEqual(second.coverage);
      expect(first.coverage).toMatchObject({
        status: 'partial',
        reason: 'source-byte-limit',
        relatedSpans: 0,
        sourceBytes: 0,
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
