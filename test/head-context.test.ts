import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBundleFixture, HEAD_SHA } from './helpers/bundle.ts';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { loadReviewCodeContext, codeContextForFile, MAX_INDEXED_CONTEXT_SOURCE_BYTES } from '../src/review/indexed-context.ts';
import { augmentHeadContext } from '../src/review/head-context.ts';
import { buildFileReviewPrompt } from '../src/review/prompt.ts';

describe('bounded captured-head discovery', () => {
  it('discovers new-file imports and test importers as source-backed candidates, not graph authority', async () => {
    const f = await createBundleFixture({ headContent: "import { helper } from './helper.js';\nexport const value = helper();\n" });
    try {
      await writeFile(join(f.source, 'src/helper.ts'), 'export const helper = () => 1;\n');
      await mkdir(join(f.source, 'test'));
      await writeFile(join(f.source, 'test/example.test.ts'), "import { value } from '../src/example';\n// EXISTING_TEST_SENTINEL\n");
      await writeFile(join(f.source, 'src/helper.test.ts'), "import { value } from 'package-alias';\n");
      const bundle = await loadReviewBundle(f.review, f.source);
      const loaded = await augmentHeadContext(bundle, await loadReviewCodeContext(bundle, undefined));
      const context = codeContextForFile(loaded, bundle.manifest.files[0]!);
      expect(context.coverage).toMatchObject({ status: 'partial', provider: { id: 'static-head', version: '1' }, revision: HEAD_SHA, relatedSpans: 2 });
      expect(context.prompt?.related.map((span) => span.path)).toEqual(['src/helper.ts', 'test/example.test.ts']);
      expect(context.prompt?.related.every((span) => span.revision === HEAD_SHA && span.graphReference === undefined)).toBe(true);
      expect(context.prompt?.related[1]?.content).toContain('EXISTING_TEST_SENTINEL');
      expect(context.prompt?.related[0]?.endLine).toBe(1);
      expect(loaded.coverage.sourceBytes).toBeLessThanOrEqual(MAX_INDEXED_CONTEXT_SOURCE_BYTES);
      const prompt = await buildFileReviewPrompt({ bundle, file: bundle.manifest.files[0]!, findingScope: 'defects', harness: 'echo', model: 'test', indexedContext: context.prompt });
      expect(prompt.user).toContain('EXISTING_TEST_SENTINEL'); expect(prompt.system).not.toContain('EXISTING_TEST_SENTINEL');
      expect(prompt.system).toContain('A local throw is not proof of a process crash');
      expect(prompt.system).toContain('not an exhaustive test or caller search');
    } finally { await f.cleanup(); }
  });

  it('rejects symlink, oversized, traversal, alias and dynamic-import candidates without executing source', async () => {
    const f = await createBundleFixture({ headContent: "import './linked';\nimport './large';\nimport '../../outside';\nimport 'alias';\nconst x = import('./dynamic');\n" });
    try {
      await writeFile(join(f.root, 'outside.ts'), 'throw new Error("never execute");\n');
      await symlink(join(f.root, 'outside.ts'), join(f.source, 'src/linked.ts')).catch(() => undefined);
      await writeFile(join(f.source, 'src/large.ts'), 'x'.repeat(128 * 1024 + 1));
      await writeFile(join(f.source, 'src/dynamic.ts'), 'throw new Error("never execute");\n');
      const bundle = await loadReviewBundle(f.review, f.source);
      const loaded = await augmentHeadContext(bundle, await loadReviewCodeContext(bundle, undefined));
      expect(loaded.files.size).toBe(0);
    } finally { await f.cleanup(); }
  });

  it('stops before reading when the run budget is exhausted', async () => {
    const f = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(f.review, f.source); const original = await loadReviewCodeContext(bundle, undefined);
      expect(await augmentHeadContext(bundle, original, () => true)).toBe(original);
    } finally { await f.cleanup(); }
  });
});
