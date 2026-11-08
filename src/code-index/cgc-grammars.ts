/** Preinstalled native grammars only. Review-time downloads are never permitted. */
import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CGC_GRAMMAR_VERSION = '1.22.1';
export const CGC_GRAMMAR_MANIFEST_SHA256 = '94b201d924980c2d32b509796ecaf943898f8d13e3220c5dfcf1ba94890c10d8';
export const CGC_GRAMMAR_IMAGE_DIRECTORY = '/opt/cgc-parsers/v' + CGC_GRAMMAR_VERSION;
/** Compare path components so sibling prefixes and parent traversal cannot satisfy the blocked-root check. */
function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value));
}
/** Find preinstalled grammar libraries outside reviewed roots; reject unsafe ownership, permissions, links, and oversized libraries without downloading. */
export async function locateCgcGrammars(blocked: readonly string[]): Promise<string | undefined> {
  const roots = await Promise.all(blocked.map(path => realpath(path).catch(() => resolve(path))));
  const base = process.env['TREE_SITTER_LANGUAGE_PACK_CACHE_DIR'] ?? process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache');
  const candidates = [process.env['TREE_SITTER_LANGUAGE_PACK_LIBS_DIR'], CGC_GRAMMAR_IMAGE_DIRECTORY,
    join(base, 'tree-sitter-language-pack', 'v' + CGC_GRAMMAR_VERSION, 'libs')];
  for (const path of candidates) {
    if (path === undefined || !isAbsolute(path) || roots.some(root => inside(root, resolve(path)))) continue;
    try {
      const canonical = await realpath(path);
      if (roots.some(root => inside(root, canonical))) continue;
      const info = await lstat(canonical);
      if (!info.isDirectory() || (process.platform !== 'win32' && ((info.mode & 0o022) !== 0
        || info.uid !== 0 && info.uid !== process.getuid?.()))) continue;
      const names = await readdir(canonical);
      if (names.length > 512) continue;
      let libraries = 0;
      for (const name of names) {
        if (!/^(?:lib)?tree_sitter_[a-z0-9_]+\.(?:so|dylib|dll)$/u.test(name)) continue;
        const file = await lstat(join(canonical, name));
        if (!file.isFile() || file.isSymbolicLink() || file.size > 32 * 1024 * 1024
          || (process.platform !== 'win32' && ((file.mode & 0o022) !== 0 || file.uid !== 0 && file.uid !== process.getuid?.()))) throw new Error('unsafe grammar library');
        libraries += 1;
      }
      if (libraries > 0) return canonical;
    } catch { /* A missing/unsafe optional native cache never blocks prompts. */ }
  }
  return undefined;
}
/** Use a private parser cache and a nonexistent local manifest to prevent review-time grammar downloads. */
export function cgcGrammarEnvironment(home: string, directory: string | undefined): Record<string, string> {
  return {
    ...(directory === undefined ? {} : { TREE_SITTER_LANGUAGE_PACK_LIBS_DIR: directory }),
    TREE_SITTER_LANGUAGE_PACK_CACHE_DIR: join(home, 'parser-cache'),
    // Fresh private cache + a nonexistent local manifest means missing grammars
    // fail closed. The loader cannot fall back to GitHub or cached remote URLs.
    TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL: pathToFileURL(join(home, 'no-parser-downloads.json')).href,
  };
}
