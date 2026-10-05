import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadReviewBundle, parseReviewManifest } from '../src/review/bundle.js';
import { BASE_SHA, createBundleFixture, HEAD_SHA } from './helpers/bundle.js';

describe('parseReviewManifest', () => {
  const validEntry = {
    id: '000001',
    status: 'M',
    oldPath: null,
    newPath: 'src/example.ts',
    similarity: null,
    additions: 1,
    deletions: 1,
    binary: false,
    diffFile: 'diffs/000001.diff',
    baseFile: 'base-files/000001',
  };

  it('accepts a valid manifest and defaults reviewed to true', () => {
    const manifest = parseReviewManifest({ version: 1, base: BASE_SHA, head: HEAD_SHA, files: [validEntry] });
    expect(manifest.files[0]?.reviewed).toBe(true);
  });

  it('rejects unsupported versions, commit shapes, and duplicate ids', () => {
    expect(() => parseReviewManifest({ version: 2, base: BASE_SHA, head: HEAD_SHA, files: [] })).toThrow(
      /unsupported version/u,
    );
    expect(() => parseReviewManifest({ version: 1, base: 'short', head: HEAD_SHA, files: [] })).toThrow(
      /full commit identifiers/u,
    );
    expect(() =>
      parseReviewManifest({
        version: 1,
        base: BASE_SHA,
        head: HEAD_SHA,
        files: [validEntry, { ...validEntry }],
      }),
    ).toThrow(/unique six-digit value/u);
  });

  it('rejects unknown fields and mismatched diff/base file references', () => {
    expect(() =>
      parseReviewManifest({
        version: 1,
        base: BASE_SHA,
        head: HEAD_SHA,
        files: [{ ...validEntry, extra: true }],
      }),
    ).toThrow(/unsupported fields/u);
    expect(() =>
      parseReviewManifest({
        version: 1,
        base: BASE_SHA,
        head: HEAD_SHA,
        files: [{ ...validEntry, diffFile: 'diffs/999999.diff' }],
      }),
    ).toThrow(/does not match its file id/u);
  });

  it('rejects entries without any repository path', () => {
    expect(() =>
      parseReviewManifest({
        version: 1,
        base: BASE_SHA,
        head: HEAD_SHA,
        files: [{ ...validEntry, oldPath: null, newPath: null }],
      }),
    ).toThrow(/at least one repository path/u);
  });
});

describe('loadReviewBundle', () => {
  it('loads a bundle and cross-checks revisions', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      expect(bundle.manifest.base).toBe(BASE_SHA);
      expect(bundle.manifest.head).toBe(HEAD_SHA);
      expect(bundle.manifest.files).toHaveLength(1);
      expect(bundle.manifest.files[0]?.newPath).toBe('src/example.ts');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects manifest/revisions disagreement', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.review, 'revisions.txt'), `base=${'c'.repeat(40)}\nhead=${HEAD_SHA}\n`);
      await expect(loadReviewBundle(fixture.review, fixture.source)).rejects.toThrow(/disagree/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a symlinked review directory', async () => {
    const fixture = await createBundleFixture();
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(fixture.review, join(fixture.root, 'review-link'));
      await expect(loadReviewBundle(join(fixture.root, 'review-link'), fixture.source)).rejects.toThrow(
        /symlink/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a diff that escapes the review root', async () => {
    const fixture = await createBundleFixture();
    try {
      const manifest = JSON.parse(await readFile(join(fixture.review, 'manifest.json'), 'utf8')) as {
        files: Array<{ id: string; diffFile: string }>;
      }
      manifest.files[0]!.diffFile = 'diffs/../../../etc/passwd';
      await writeFile(join(fixture.review, 'manifest.json'), JSON.stringify(manifest));
      await expect(loadReviewBundle(fixture.review, fixture.source)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});
