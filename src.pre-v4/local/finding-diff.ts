/** Bounded terminal excerpts from captured diffs, never model-generated diff text. */
import { loadReviewBundle, readCheckedText, type ReviewBundle } from '../review/bundle.ts';
import { parseChangedLines } from '../review/report.ts';
import type { PullRequestFinding } from '../review/types.ts';

export const MAX_EXCERPT_LINES = 20;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_ROWS = 40_000;
const CONTEXT_LINES = 3;

export interface DiffExcerptLine {
  readonly text: string;
  readonly left: number | null;
  readonly right: number | null;
  readonly cited: boolean;
}
export interface FindingDiffExcerpt {
  readonly header: string;
  readonly lines: readonly DiffExcerptLine[];
  readonly truncated: boolean;
}

/** Select one hunk around the cited side/start, preserving original line numbers. */
export function findingDiffExcerpt(diff: string, finding: PullRequestFinding): FindingDiffExcerpt | undefined {
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) return undefined;
  const raw = diff.split('\n');
  if (raw.length > MAX_DIFF_ROWS) return undefined;
  let changed: ReturnType<typeof parseChangedLines>;
  try { changed = parseChangedLines(diff, 'terminal diff'); } catch { return undefined; }
  const side = finding.side === 'LEFT' ? changed.left : changed.right;
  if (side.get(finding.startLine) !== finding.evidence || !side.has(finding.endLine)) return undefined;
  let left = 0;
  let right = 0;
  let header = '';
  let inHunk = false;
  let rows: DiffExcerptLine[] = [];
  let anchor = -1;
  const selected = (): FindingDiffExcerpt | undefined => {
    if (anchor < 0) return undefined;
    const start = Math.max(0, anchor - CONTEXT_LINES);
    const lastCited = rows.findLastIndex((row) => row.cited);
    const end = Math.min(rows.length, start + MAX_EXCERPT_LINES, Math.max(anchor + 1, lastCited + 1) + CONTEXT_LINES);
    const spanEndVisible = rows.slice(start, end).some((row) => (finding.side === 'LEFT' ? row.left : row.right) === finding.endLine);
    return { header, lines: rows.slice(start, end), truncated: start > 0 || end < rows.length || !spanEndVisible };
  };
  for (const text of raw) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk !== null) {
      if (anchor >= 0) return selected();
      header = text;
      inHunk = true;
      rows = [];
      left = Number(hunk[1]); right = Number(hunk[2]);
      continue;
    }
    if (!inHunk) continue;
    if (![' ', '-', '+'].includes(text[0] ?? '')) {
      if (!text.startsWith('\\')) inHunk = false;
      continue;
    }
    const marker = text[0];
    const oldLine = marker === '+' ? null : left++;
    const newLine = marker === '-' ? null : right++;
    const number = finding.side === 'LEFT' ? oldLine : newLine;
    const changedOnSide = marker === (finding.side === 'LEFT' ? '-' : '+');
    const cited = changedOnSide && number !== null && number >= finding.startLine && number <= finding.endLine;
    if (cited && number === finding.startLine) anchor = rows.length;
    rows.push({ text, left: oldLine, right: newLine, cited });
  }
  return selected();
}

/** A private captured bundle is revalidated before its optional excerpts are displayed. */
export class FindingDiffReader {
  private readonly reviewDirectory: string;
  private readonly sourceDirectory: string;
  private bundle: Promise<ReviewBundle> | undefined;
  private readonly diffs = new Map<string, string>();
  constructor(reviewDirectory: string, sourceDirectory: string) {
    this.reviewDirectory = reviewDirectory; this.sourceDirectory = sourceDirectory;
  }
  async read(finding: PullRequestFinding, revisions: { readonly base: string; readonly head: string }): Promise<FindingDiffExcerpt | undefined> {
    try {
      this.bundle ??= loadReviewBundle(this.reviewDirectory, this.sourceDirectory);
      const bundle = await this.bundle;
      if (bundle.manifest.base !== revisions.base || bundle.manifest.head !== revisions.head) return undefined;
      const file = bundle.manifest.files.find((item) => item.id === finding.triggerFileId);
      if (file === undefined || (file.newPath ?? file.oldPath) !== finding.triggerPath || file.binary || !file.reviewed) return undefined;
      let diff = this.diffs.get(file.id);
      if (diff === undefined) {
        diff = await readCheckedText(bundle.root, file.diffFile, MAX_DIFF_BYTES, 'terminal diff');
        this.diffs.set(file.id, diff);
      }
      return findingDiffExcerpt(diff, finding);
    } catch {
      // Optional presentation must not downgrade a validated review or invent context.
      return undefined;
    }
  }
}
