/** Static lexical candidates from captured source, never executed or treated as graph facts. */
import type { Dirent } from 'node:fs';
import { opendir, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { checkedFile, type ReviewBundle } from './bundle.ts';
import {
  codeContextForFile, MAX_INDEXED_CONTEXT_SOURCE_BYTES, MAX_INDEXED_CONTEXT_SOURCE_BYTES_PER_FILE,
  type LoadedReviewCodeContext, type ResolvedRelatedCodeSpan,
} from './indexed-context.ts';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PROVIDER = { id: 'static-head', version: '1' };
const LIMITS = { files: 512, directories: 256, depth: 12, fileBytes: 128 * 1024, totalBytes: 8 * 1024 * 1024, imports: 32, importLineCharacters: 1_024, related: 4, spanBytes: 8 * 1024 };
interface CapturedText { readonly lines: readonly string[]; readonly imports: readonly { specifier: string; line: number }[] }

async function capturedTexts(bundle: ReviewBundle, stop: () => boolean): Promise<Map<string, CapturedText>> {
  const texts = new Map<string, CapturedText>();
  const pending = [''];
  let directories = 0; let files = 0; let bytes = 0;
  while (pending.length && directories++ < LIMITS.directories && !stop()) {
    const relative = pending.shift()!;
    try {
      const directory = await opendir(relative ? bundle.sourceRoot + '/' + relative : bundle.sourceRoot);
      const entries: Dirent[] = [];
      for await (const entry of directory) {
        entries.push(entry);
        if (entries.length > 4096) break;
      }
      if (entries.length > 4096) continue;
      for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (stop() || files >= LIMITS.files || bytes >= LIMITS.totalBytes) break;
        const path = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isDirectory() && !entry.name.startsWith('.') && path.split('/').length < LIMITS.depth
          && pending.length < LIMITS.directories) pending.push(path);
        if (!entry.isFile() || !EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
        files += 1;
        try {
          const candidate = await checkedFile(bundle.sourceRoot, path, LIMITS.fileBytes, 'static captured head source');
          const data = await readFile(candidate);
          bytes += data.byteLength;
          if (bytes > LIMITS.totalBytes || data.byteLength > LIMITS.fileBytes) break;
          const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
          if (text.includes('\0')) continue;
          const sourceLines = text.split('\n');
          if (sourceLines.at(-1) === '') sourceLines.pop();
          const lines = sourceLines.slice(0, 4096).map((line) => line.replace(/\r$/u, ''));
          const imports: { specifier: string; line: number }[] = [];
          for (const [index, line] of lines.entries()) {
            if (imports.length >= LIMITS.imports) break;
            // Literal relative ESM imports/re-exports only. Comments, aliases,
            // dynamic imports, package exports and runtime resolution are not inferred.
            if (line.length > LIMITS.importLineCharacters) continue;
            const match = /^\s*(?:import|export)\s+(?:[^'"\r\n]*?\sfrom\s*)?['"](\.[^'"\r\n]{1,256})['"]/u.exec(line);
            if (match) imports.push({ specifier: match[1]!, line: index + 1 });
          }
          texts.set(path, { lines, imports });
        } catch { /* Unsafe, non-UTF8, missing or oversized source remains unavailable. */ }
      }
    } catch { /* Captured omissions never become evidence of absence. */ }
    pending.sort();
  }
  return texts;
}

function importTarget(from: string, specifier: string, texts: ReadonlyMap<string, CapturedText>): string | undefined {
  const path = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (path.startsWith('../') || posix.isAbsolute(path) || path.includes('\\')) return undefined;
  const stem = path.replace(/\.(?:mjs|cjs|js|jsx)$/u, '');
  return [path, ...EXTENSIONS.map((ext) => stem + ext), ...EXTENSIONS.map((ext) => path + '/index' + ext)].find((item) => texts.has(item));
}

export async function augmentHeadContext(bundle: ReviewBundle, loaded: LoadedReviewCodeContext, stop: () => boolean = () => false): Promise<LoadedReviewCodeContext> {
  const texts = await capturedTexts(bundle, stop);
  const edges = [...texts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([from, source]) =>
    source.imports.flatMap((item) => {
      const to = importTarget(from, item.specifier, texts);
      return to === undefined ? [] : [{ from, to, line: item.line }];
    }));
  const files = new Map(loaded.files);
  let sourceBytes = loaded.coverage.sourceBytes; let addedSpans = 0; let addedFiles = 0;
  for (const file of bundle.manifest.files) {
    if (stop()) break;
    if (!file.reviewed || file.binary || file.newPath === null || codeContextForFile(loaded, file).prompt !== undefined) continue;
    const related: ResolvedRelatedCodeSpan[] = [];
    let fileBytes = 0;
    const seen = new Set<string>();
    for (const edge of edges) {
      const incoming: boolean = edge.to === file.newPath;
      const path: string | undefined = incoming ? edge.from : edge.from === file.newPath ? edge.to : undefined;
      if (path === undefined || path === file.newPath || seen.has(path)) continue;
      const source = texts.get(path)!;
      const startLine = Math.max(1, incoming ? edge.line - 8 : 1);
      const endLine = Math.min(source.lines.length, startLine + 39);
      const content = source.lines.slice(startLine - 1, endLine).join('\n');
      const size = Buffer.byteLength(content, 'utf8');
      if (size > LIMITS.spanBytes || fileBytes + size > MAX_INDEXED_CONTEXT_SOURCE_BYTES_PER_FILE
        || sourceBytes + size > MAX_INDEXED_CONTEXT_SOURCE_BYTES) continue;
      related.push({ path, startLine, endLine, content, provider: PROVIDER, revision: bundle.manifest.head,
        status: 'partial', reason: incoming ? 'Captured-head literal import candidate (incoming); not a verified call path.' : 'Captured-head literal import candidate (outgoing); not a verified call path.' });
      seen.add(path); fileBytes += size; sourceBytes += size;
      if (related.length >= LIMITS.related) break;
    }
    if (related.length === 0) continue;
    addedFiles += 1; addedSpans += related.length;
    files.set(file.newPath, {
      coverage: { status: 'partial', provider: PROVIDER, revision: bundle.manifest.head, relatedSpans: related.length, sourceBytes: fileBytes, reason: 'provider-partial' },
      prompt: { status: 'partial', related, limitation: 'Bounded static-head lexical discovery only. Not a dependency graph, proof of reachability, exhaustive test search, or evidence that missing relationships do not exist.' },
    });
  }
  if (addedFiles === 0) return loaded;
  return { ...loaded, files, coverage: { ...loaded.coverage, status: 'partial',
    filesWithContext: loaded.coverage.filesWithContext + addedFiles, sourceBytes,
    relatedSpans: loaded.coverage.relatedSpans + addedSpans,
    diagnosticCodes: [...loaded.coverage.diagnosticCodes, 'static-head-context'] } };
}
