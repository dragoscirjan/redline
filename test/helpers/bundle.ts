/**
 * Shared test fixture: a minimal review bundle on disk, matching what
 * `context-bundle.sh` produces.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BASE_SHA = 'a'.repeat(40);
export const HEAD_SHA = 'b'.repeat(40);

export interface BundleFixture {
  readonly root: string;
  readonly review: string;
  readonly source: string;
  readonly output: string;
  cleanup(): Promise<void>;
}

export interface BundleFixtureOptions {
  readonly manifestOverrides?: Record<string, unknown>;
  readonly diff?: string;
  readonly headContent?: string;
  readonly reviewed?: boolean;
}

export async function createBundleFixture(options: BundleFixtureOptions = {}): Promise<BundleFixture> {
  const root = await mkdtemp(join(tmpdir(), 'redline-test-'));
  const review = join(root, 'review');
  const source = join(root, 'source');
  const output = join(root, 'output');
  await mkdir(join(review, 'diffs'), { recursive: true });
  await mkdir(join(review, 'base-files'), { recursive: true });
  await mkdir(join(source, 'src'), { recursive: true });

  const manifestEntry = {
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
    ...(options.reviewed !== undefined ? { reviewed: options.reviewed } : {}),
    ...(options.manifestOverrides ?? {}),
  };

  await writeFile(join(review, 'revisions.txt'), `base=${BASE_SHA}\nhead=${HEAD_SHA}\n`);
  await writeFile(
    join(review, 'manifest.json'),
    JSON.stringify({ version: 1, base: BASE_SHA, head: HEAD_SHA, files: [manifestEntry] }),
  );
  await writeFile(
    join(review, 'diffs/000001.diff'),
    options.diff ??
      'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
  );
  await writeFile(join(review, 'base-files/000001'), 'old\n');
  await writeFile(join(source, 'src/example.ts'), options.headContent ?? 'new\n');

  return {
    root,
    review,
    source,
    output,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function cleanReviewEnvironment(fixture: BundleFixture, harness: string): NodeJS.ProcessEnv {
  return {
    REDLINE_HARNESS: harness,
    REDLINE_REVIEW_DIR: fixture.review,
    REDLINE_SOURCE_DIR: fixture.source,
    REDLINE_OUTPUT_DIR: fixture.output,
    REDLINE_MODEL_CONFIG: JSON.stringify({
      provider: 'mock',
      endpoint: 'http://127.0.0.1:8787/v1',
      model: 'test-model',
    }),
    REDLINE_MODEL_AUTH: JSON.stringify({ mock: 'test-key' }),
  };
}
