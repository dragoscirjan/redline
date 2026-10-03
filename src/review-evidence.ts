import { lstat, readFile } from 'node:fs/promises';
import {
  byteLength,
  checkedFile,
  optionalCheckedFile,
  type ReviewBundle,
} from './review-bundle.js';

export const MAX_INLINE_EVIDENCE_BYTES = 512 * 1024;
export const MAX_INLINE_DIFF_BYTES = 128 * 1024;
const MAX_SUPPORTING_TEXT_BYTES = 32 * 1024;

export type InlineText =
  | { status: 'included'; text: string }
  | { status: 'omitted'; reason: string };

export interface InlineFileEvidence {
  fileId: string;
  diff: InlineText;
  head?: InlineText;
  base?: InlineText;
}

export interface InlineReviewEvidence {
  evidence: InlineFileEvidence[];
  supportingDocuments: Record<string, InlineText>;
  omittedFileIds: string[];
}

async function readText(path: string, limit: number): Promise<InlineText> {
  if ((await lstat(path)).size > limit) return { status: 'omitted', reason: 'Text exceeds the inline byte limit.' };
  const bytes = await readFile(path);
  if (bytes.byteLength > limit) return { status: 'omitted', reason: 'Text exceeds the inline byte limit.' };
  try {
    return { status: 'included', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { status: 'omitted', reason: 'Text is not valid UTF-8.' };
  }
}

async function readSupportingText(root: string, relativePath: string): Promise<InlineText> {
  try {
    const path = await optionalCheckedFile(root, relativePath, Number.MAX_SAFE_INTEGER);
    return path
      ? await readText(path, MAX_SUPPORTING_TEXT_BYTES)
      : { status: 'omitted', reason: 'Supporting file is unavailable.' };
  } catch {
    // Optional context must not abort a reviewable diff or expose unsafe paths.
    return { status: 'omitted', reason: 'Supporting file is unavailable or is not safe to read.' };
  }
}

/** Include whole diffs first; supporting context never displaces required evidence. */
export async function collectInlineReviewEvidence(bundle: ReviewBundle): Promise<InlineReviewEvidence> {
  const evidence: InlineFileEvidence[] = bundle.manifest.files.map((file) => ({
    fileId: file.id,
    diff: { status: 'omitted', reason: 'Diff exceeds the inline context budget.' },
  }));
  const supportingDocuments: Record<string, InlineText> = {};
  let bytes = byteLength(JSON.stringify({ evidence, supportingDocuments }));
  if (bytes > MAX_INLINE_EVIDENCE_BYTES) throw new Error('inline evidence metadata exceeds its byte limit');

  const replace = (index: number, candidate: InlineFileEvidence): boolean => {
    const previous = evidence[index] as InlineFileEvidence;
    const nextBytes = bytes - byteLength(JSON.stringify(previous)) + byteLength(JSON.stringify(candidate));
    if (nextBytes > MAX_INLINE_EVIDENCE_BYTES) return false;
    evidence[index] = candidate;
    bytes = nextBytes;
    return true;
  };

  for (const [index, file] of bundle.manifest.files.entries()) {
    const diff: InlineText = file.binary
      ? { status: 'omitted', reason: 'Binary diffs cannot be reviewed as text.' }
      : await readText(
          await checkedFile(bundle.root, file.diffFile, 2 * 1024 * 1024, file.diffFile),
          MAX_INLINE_DIFF_BYTES,
        );
    replace(index, { fileId: file.id, diff });
  }

  for (const [index, file] of bundle.manifest.files.entries()) {
    const current = evidence[index] as InlineFileEvidence;
    if (current.diff.status !== 'included') continue;
    for (const side of ['head', 'base'] as const) {
      const relativePath = side === 'head' ? file.newPath : file.baseFile;
      if (!relativePath) continue;
      const root = side === 'head' ? bundle.sourceRoot : bundle.root;
      const text = await readSupportingText(root, relativePath);
      replace(index, { ...evidence[index] as InlineFileEvidence, [side]: text });
    }
  }

  for (const name of ['requirements.md', 'summary.txt', 'commits.txt', 'README.md']) {
    const path = await optionalCheckedFile(bundle.root, name, 2 * 1024 * 1024);
    if (!path) continue;
    const text = await readText(path, MAX_SUPPORTING_TEXT_BYTES);
    const cost = byteLength(JSON.stringify(name)) + 1 + byteLength(JSON.stringify(text)) +
      (Object.keys(supportingDocuments).length > 0 ? 1 : 0);
    if (bytes + cost <= MAX_INLINE_EVIDENCE_BYTES) {
      supportingDocuments[name] = text;
      bytes += cost;
    }
  }

  return {
    evidence,
    supportingDocuments,
    omittedFileIds: evidence.filter((item) => item.diff.status === 'omitted').map((item) => item.fileId),
  };
}
