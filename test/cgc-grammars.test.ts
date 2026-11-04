import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cgcGrammarEnvironment, locateCgcGrammars } from '../src/code-index/cgc-grammars.ts';

afterEach(() => vi.unstubAllEnvs());
describe('CGC offline grammar boundary', () => {
  it('uses a preinstalled cache but rejects libraries selected from captured/repository paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-grammars-'));
    try {
      const libraries = join(root, 'libraries'); await mkdir(libraries, { mode: 0o700 });
      await writeFile(join(libraries, 'libtree_sitter_python.so'), 'synthetic fixture, never loaded', { mode: 0o600 });
      vi.stubEnv('TREE_SITTER_LANGUAGE_PACK_LIBS_DIR', libraries);
      expect(await locateCgcGrammars([join(root, 'captured')])).toBe(libraries);
      const rejected = await locateCgcGrammars([root]);
      expect(rejected).not.toBe(libraries);
      const environment = cgcGrammarEnvironment(join(root, 'home'), libraries);
      expect(environment.TREE_SITTER_LANGUAGE_PACK_LIBS_DIR).toBe(libraries);
      expect(environment.TREE_SITTER_LANGUAGE_PACK_CACHE_DIR).toBe(join(root, 'home', 'parser-cache'));
      expect(environment.TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL).toMatch(/^file:/u);
      expect(environment.TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL).not.toMatch(/https?:/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('rejects shared-writable and symlinked grammar files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-grammars-'));
    try {
      const library = join(root, 'libtree_sitter_python.so');
      await writeFile(library, 'synthetic fixture', { mode: 0o600 });
      vi.stubEnv('TREE_SITTER_LANGUAGE_PACK_LIBS_DIR', root);
      await chmod(library, 0o666);
      expect(await locateCgcGrammars([])).not.toBe(root);
      await rm(library); await writeFile(join(root, 'elsewhere'), 'fixture');
      await symlink(join(root, 'elsewhere'), library);
      expect(await locateCgcGrammars([])).not.toBe(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
