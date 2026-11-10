import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureInside } from './bundle.ts';

export const MAX_SOURCE_CONTEXT_FILE_BYTES = 128 * 1024;
export const MAX_SOURCE_CONTEXT_BYTES_PER_SIDE = 64 * 1024;
const SURROUNDING_LINES = 16;
const MAX_SYMBOL_SEARCH_LINES = 300;

export type SourceContextSide = 'base' | 'head';
export type SourceContextSelection = 'changed-hunk' | 'containing-symbol' | 'whole-small-file' | 'fallback-prefix';

export interface SourceContextExcerpt {
  readonly startLine: number;
  readonly endLine: number;
  readonly selections: readonly SourceContextSelection[];
  readonly content: string;
}

export interface FocusedSourceContext {
  readonly revision: string;
  readonly path: string | null;
  readonly side: SourceContextSide;
  readonly status: 'included' | 'absent' | 'not-needed' | 'omitted';
  readonly reason: string | null;
  readonly originalBytes: number;
  readonly embeddedBytes: number;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly excerpts: readonly SourceContextExcerpt[];
}

interface LineRange {
  startLine: number;
  endLine: number;
  selections: Set<SourceContextSelection>;
}

interface DiffChangedLines {
  readonly base: readonly number[];
  readonly head: readonly number[];
}

function absentSource(
  revision: string,
  path: string | null,
  side: SourceContextSide,
  status: FocusedSourceContext['status'],
  reason: string,
): FocusedSourceContext {
  return {
    revision,
    path,
    side,
    status,
    reason,
    originalBytes: 0,
    embeddedBytes: 0,
    totalLines: 0,
    truncated: false,
    excerpts: [],
  };
}

function parseChangedLines(diff: string): DiffChangedLines {
  const base: number[] = [];
  const head: number[] = [];
  let baseLine: number | undefined;
  let headLine: number | undefined;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk !== null) {
      baseLine = Number(hunk[1]);
      headLine = Number(hunk[2]);
      continue;
    }
    if (baseLine === undefined || headLine === undefined) continue;
    if (line.startsWith('-')) {
      base.push(baseLine);
      baseLine += 1;
      continue;
    }
    if (line.startsWith('+')) {
      head.push(headLine);
      headLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      baseLine += 1;
      headLine += 1;
    }
  }
  return { base, head };
}

function sourceLines(content: string): string[] {
  if (content.length === 0) return [];
  const values = content.split('\n');
  const hasFinalNewline = values.at(-1) === '';
  if (hasFinalNewline) values.pop();
  return values.map((line, index) => `${line}${index < values.length - 1 || hasFinalNewline ? '\n' : ''}`);
}

function contiguousRanges(lines: readonly number[], totalLines: number): LineRange[] {
  const selected = [...new Set(lines.filter((line) => line >= 1 && line <= totalLines))].sort((left, right) => left - right);
  const ranges: LineRange[] = [];
  for (const line of selected) {
    const current = ranges.at(-1);
    if (current !== undefined && line <= current.endLine + 1) {
      current.endLine = line;
    } else {
      ranges.push({ startLine: line, endLine: line, selections: new Set(['changed-hunk']) });
    }
  }
  return ranges.map((range) => ({
    startLine: Math.max(1, range.startLine - SURROUNDING_LINES),
    endLine: Math.min(totalLines, range.endLine + SURROUNDING_LINES),
    selections: range.selections,
  }));
}

const DECLARATION_WITH_BRACE = /^(?:\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|enum|namespace)\b|\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*[^=]*=.*=>|\s*(?:(?:public|private|protected|static|readonly|abstract|async|get|set)\s+)*[A-Za-z_$][\w$]*\s*\([^;]*\))/u;
const PYTHON_DECLARATION = /^(\s*)(?:async\s+def|def|class)\s+[A-Za-z_]\w*/u;

function braceDeltas(lines: readonly string[]): number[] {
  let blockComment = false;
  return lines.map((line) => {
    let delta = 0;
    let quote: "'" | '"' | '`' | undefined;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      const next = line[index + 1];
      if (blockComment) {
        if (character === '*' && next === '/') {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote !== undefined) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        }
        continue;
      }
      if (character === '/' && next === '/') break;
      if (character === '/' && next === '*') {
        blockComment = true;
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        quote = character;
      } else if (character === '{') {
        delta += 1;
      } else if (character === '}') {
        delta -= 1;
      }
    }
    return delta;
  });
}

function braceSymbolRange(lines: readonly string[], changedLine: number, deltas: readonly number[]): LineRange | undefined {
  const changedIndex = changedLine - 1;
  const minimum = Math.max(0, changedIndex - MAX_SYMBOL_SEARCH_LINES);
  for (let start = changedIndex; start >= minimum; start -= 1) {
    const line = lines[start] ?? '';
    if (!DECLARATION_WITH_BRACE.test(line)) continue;
    const openingLimit = Math.min(changedIndex, start + 3);
    if (!lines.slice(start, openingLimit + 1).some((candidate) => candidate.includes('{'))) continue;
    let depth = 0;
    let opened = false;
    for (let end = start; end < lines.length; end += 1) {
      depth += deltas[end] ?? 0;
      if ((deltas[end] ?? 0) > 0) opened = true;
      if (opened && depth <= 0) {
        if (end >= changedIndex) {
          return { startLine: start + 1, endLine: end + 1, selections: new Set(['containing-symbol']) };
        }
        break;
      }
    }
  }
  return undefined;
}

function pythonSymbolRange(lines: readonly string[], changedLine: number): LineRange | undefined {
  const changedIndex = changedLine - 1;
  const minimum = Math.max(0, changedIndex - MAX_SYMBOL_SEARCH_LINES);
  for (let start = changedIndex; start >= minimum; start -= 1) {
    const match = PYTHON_DECLARATION.exec(lines[start] ?? '');
    if (match === null) continue;
    const indentation = match[1]!.length;
    let end = start;
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.trim().length === 0) {
        end = index;
        continue;
      }
      const nextIndentation = /^\s*/u.exec(line)?.[0].length ?? 0;
      if (nextIndentation <= indentation) break;
      end = index;
    }
    if (end >= changedIndex) {
      return { startLine: start + 1, endLine: end + 1, selections: new Set(['containing-symbol']) };
    }
  }
  return undefined;
}

function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const current = merged.at(-1);
    if (current !== undefined && range.startLine <= current.endLine + 1) {
      current.endLine = Math.max(current.endLine, range.endLine);
      for (const selection of range.selections) current.selections.add(selection);
    } else {
      merged.push({ ...range, selections: new Set(range.selections) });
    }
  }
  return merged;
}

function rangeBytes(lines: readonly string[], range: LineRange): number {
  return Buffer.byteLength(lines.slice(range.startLine - 1, range.endLine).join(''), 'utf8');
}

function renderRanges(lines: readonly string[], ranges: readonly LineRange[]): {
  readonly excerpts: readonly SourceContextExcerpt[];
  readonly embeddedBytes: number;
  readonly truncated: boolean;
} {
  const excerpts: SourceContextExcerpt[] = [];
  let embeddedBytes = 0;
  let truncated = false;
  for (const range of ranges) {
    const selected: string[] = [];
    let endLine = range.startLine - 1;
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      const value = lines[line - 1] ?? '';
      const bytes = Buffer.byteLength(value, 'utf8');
      if (embeddedBytes + bytes > MAX_SOURCE_CONTEXT_BYTES_PER_SIDE) {
        truncated = true;
        break;
      }
      selected.push(value);
      embeddedBytes += bytes;
      endLine = line;
    }
    if (selected.length > 0) {
      excerpts.push({
        startLine: range.startLine,
        endLine,
        selections: [...range.selections].sort(),
        content: selected.join(''),
      });
    }
    if (endLine < range.endLine) break;
  }
  if (excerpts.length < ranges.length) truncated = true;
  return { excerpts, embeddedBytes, truncated };
}

export async function buildFocusedSourceContext(options: {
  readonly root: string;
  readonly relativePath: string | null;
  readonly displayPath: string | null;
  readonly revision: string;
  readonly side: SourceContextSide;
  readonly diff: string;
  readonly needed: boolean;
  /** Retry-only source enrichment, within the same file and per-side limits. */
  readonly enrich?: boolean;
}): Promise<FocusedSourceContext> {
  const { revision, displayPath, side } = options;
  if (!options.needed) return absentSource(revision, displayPath, side, 'not-needed', 'authoritative diff and selected head source are sufficient');
  if (options.relativePath === null || displayPath === null) {
    return absentSource(revision, displayPath, side, 'absent', `no ${side} file exists for this change`);
  }
  const candidate = resolve(options.root, options.relativePath);
  try {
    ensureInside(options.root, candidate, 'focused source context');
  } catch {
    return absentSource(revision, displayPath, side, 'omitted', 'source path escapes its trusted root');
  }
  const info = await lstat(candidate).catch(() => undefined);
  if (info === undefined) return absentSource(revision, displayPath, side, 'absent', `${side} source is unavailable`);
  if (!info.isFile() || info.isSymbolicLink()) {
    return absentSource(revision, displayPath, side, 'omitted', `${side} source is not a regular file`);
  }
  if (info.size > MAX_SOURCE_CONTEXT_FILE_BYTES) {
    return absentSource(revision, displayPath, side, 'omitted', `${side} source exceeds the file byte limit`);
  }
  const content = await readFile(candidate, 'utf8').catch(() => null);
  if (content === null) return absentSource(revision, displayPath, side, 'omitted', `${side} source could not be read`);
  const originalBytes = Buffer.byteLength(content, 'utf8');
  if (originalBytes > MAX_SOURCE_CONTEXT_FILE_BYTES) {
    return absentSource(revision, displayPath, side, 'omitted', `${side} source exceeds the file byte limit`);
  }
  const lines = sourceLines(content);
  const changed = parseChangedLines(options.diff)[side];
  let primary = contiguousRanges(changed, lines.length);
  if (primary.length === 0 && lines.length > 0) {
    primary = [{
      startLine: 1,
      endLine: originalBytes <= MAX_SOURCE_CONTEXT_BYTES_PER_SIDE ? lines.length : Math.min(lines.length, 80),
      selections: new Set([originalBytes <= MAX_SOURCE_CONTEXT_BYTES_PER_SIDE ? 'whole-small-file' : 'fallback-prefix']),
    }];
  }

  const deltas = braceDeltas(lines);
  const symbols = changed.flatMap((line) => {
    const selected = braceSymbolRange(lines, line, deltas) ?? pythonSymbolRange(lines, line);
    return selected === undefined ? [] : [selected];
  });
  if (options.enrich === true && originalBytes <= MAX_SOURCE_CONTEXT_BYTES_PER_SIDE && lines.length > 0) {
    primary = [{ startLine: 1, endLine: lines.length, selections: new Set(['whole-small-file']) }];
  }
  let selectedRanges = mergeRanges([...primary, ...symbols]);
  if (selectedRanges.reduce((total, range) => total + rangeBytes(lines, range), 0) > MAX_SOURCE_CONTEXT_BYTES_PER_SIDE) {
    selectedRanges = mergeRanges(primary);
  }
  if (options.enrich === true && originalBytes > MAX_SOURCE_CONTEXT_BYTES_PER_SIDE) {
    const expanded = mergeRanges(selectedRanges.map((range) => ({ ...range,
      startLine: Math.max(1, range.startLine - 64), endLine: Math.min(lines.length, range.endLine + 64) })));
    if (expanded.reduce((total, range) => total + rangeBytes(lines, range), 0) <= MAX_SOURCE_CONTEXT_BYTES_PER_SIDE) selectedRanges = expanded;
  }
  const rendered = renderRanges(lines, selectedRanges);
  if (rendered.excerpts.length === 0) {
    return {
      revision,
      path: displayPath,
      side,
      status: 'omitted',
      reason: `${side} source selection exceeded the byte limit`,
      originalBytes,
      embeddedBytes: 0,
      totalLines: lines.length,
      truncated: true,
      excerpts: [],
    };
  }
  return {
    revision,
    path: displayPath,
    side,
    status: 'included',
    reason: null,
    originalBytes,
    embeddedBytes: rendered.embeddedBytes,
    totalLines: lines.length,
    truncated: rendered.truncated || rendered.embeddedBytes < originalBytes,
    excerpts: rendered.excerpts,
  };
}
