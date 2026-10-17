import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { checkedFile, type ReviewBundle } from './bundle.js';
import type { SourceEvidence } from './types.js';

const MAX_EVIDENCE_SOURCE_BYTES = 2 * 1024 * 1024;

/** Captured source exists, but a provider's claimed span does not match it. */
export class SourceMismatchError extends Error {
  readonly code = 'source-mismatch' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SourceMismatchError';
  }
}

function sourceLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

async function readStrictUtf8(path: string, label: string): Promise<string[]> {
  const bytes = await readFile(path);
  try {
    return sourceLines(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

async function evidenceSource(bundle: ReviewBundle, evidence: SourceEvidence): Promise<string[]> {
  if (evidence.revision === bundle.manifest.head) {
    const path = await checkedFile(
      bundle.sourceRoot,
      evidence.path,
      MAX_EVIDENCE_SOURCE_BYTES,
      `supporting evidence ${evidence.path}`,
    );
    return readStrictUtf8(path, `supporting evidence ${evidence.path}`);
  }
  if (evidence.revision !== bundle.manifest.base) {
    throw new Error('supporting evidence revision is not the reviewed base or head');
  }
  const owner = bundle.manifest.files.find((file) => file.oldPath === evidence.path && file.baseFile !== null);
  if (owner?.baseFile === null || owner === undefined) {
    throw new Error(`base supporting evidence is not captured for ${evidence.path}`);
  }
  const path = await checkedFile(
    bundle.root,
    owner.baseFile,
    MAX_EVIDENCE_SOURCE_BYTES,
    `base supporting evidence ${evidence.path}`,
  );
  return readStrictUtf8(path, `base supporting evidence ${evidence.path}`);
}

/** Re-resolves one bounded citation from captured base or exact-head source. */
export async function validateSourceEvidence(bundle: ReviewBundle, evidence: SourceEvidence): Promise<void> {
  if (!Number.isSafeInteger(evidence.startLine) || evidence.startLine < 1
    || !Number.isSafeInteger(evidence.endLine) || evidence.endLine < evidence.startLine) {
    throw new Error(`supporting evidence span is invalid for ${evidence.path}`);
  }
  const lines = await evidenceSource(bundle, evidence);
  if (evidence.endLine > lines.length) {
    throw new SourceMismatchError(`supporting evidence span exceeds captured source for ${evidence.path}`);
  }
  if (lines[evidence.startLine - 1] !== evidence.evidence) {
    throw new SourceMismatchError(`supporting evidence does not match captured source for ${evidence.path}`);
  }
}
