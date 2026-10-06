/**
 * Parses and validates the per-file review document a harness returns.
 *
 * Model output is untrusted and rejected rather than guessed: the document
 * must match the exact schema, target the file under review, and every
 * finding must anchor to changed lines of the authoritative diff — both
 * span endpoints must be changed lines and the evidence must be
 * byte-identical to the start line. Findings that fail validation
 * invalidate the whole document (the caller records an invalid-output
 * outcome instead of publishing an unvalidated finding).
 */

import { createHash } from 'node:crypto';
import { assertOnlyKeys, isRecord, type ReviewManifestFile } from './bundle.js';
import type {
  FindingCategory,
  FindingClassification,
  FindingScope,
  FindingSeverity,
  FindingSide,
  ReviewFinding,
  ValidatedFinding,
} from './types.js';

export const FILE_REVIEW_DOCUMENT_VERSION = 2 as const;
export const MAX_FILE_FINDINGS = 10;
export const MAX_SUGGESTED_CHANGE_CHARS = 8 * 1024;

const CATEGORIES = ['correctness', 'security', 'regression', 'testing', 'operational', 'maintainability'] as const;
const CLASSIFICATIONS = ['defect', 'risk'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const SIDES = ['LEFT', 'RIGHT'] as const;
const OUTCOMES = ['clean', 'findings', 'omitted'] as const;

export interface FileReviewDocument {
  readonly version: typeof FILE_REVIEW_DOCUMENT_VERSION;
  readonly fileId: string;
  readonly outcome: 'clean' | 'findings' | 'omitted';
  readonly reason: string | undefined;
  readonly findings: readonly ReviewFinding[];
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length === 0 || value.length > maximumLength) throw new Error(`${label} is invalid`);
  if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function parseFinding(value: unknown): ReviewFinding {
  if (!isRecord(value)) throw new Error('finding must be an object');
  assertOnlyKeys(
    value,
    [
      'category',
      'classification',
      'severity',
      'confidence',
      'side',
      'startLine',
      'endLine',
      'evidence',
      'impact',
      'fix',
      'suggestedChange',
    ],
    'finding',
  );
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) {
    throw new Error('finding.confidence must be a finite number');
  }
  if (value.confidence < 0 || value.confidence > 1) {
    throw new Error('finding.confidence must be between 0 and 1');
  }
  const startLine = positiveInteger(value.startLine, 'finding.startLine');
  const endLine = positiveInteger(value.endLine, 'finding.endLine');
  if (startLine > endLine) {
    throw new Error('finding.startLine must not exceed finding.endLine');
  }
  const suggestedChange =
    value.suggestedChange === undefined
      ? undefined
      : boundedString(value.suggestedChange, 'finding.suggestedChange', MAX_SUGGESTED_CHANGE_CHARS);
  return {
    category: enumValue(value.category, CATEGORIES, 'finding.category'),
    classification: enumValue(value.classification, CLASSIFICATIONS, 'finding.classification'),
    severity: enumValue(value.severity, SEVERITIES, 'finding.severity'),
    confidence: value.confidence,
    side: enumValue(value.side, SIDES, 'finding.side'),
    startLine,
    endLine,
    evidence: boundedString(value.evidence, 'finding.evidence', 4_096),
    impact: boundedString(value.impact, 'finding.impact', 4_096),
    fix: boundedString(value.fix, 'finding.fix', 4_096),
    ...(suggestedChange !== undefined ? { suggestedChange } : {}),
  };
}

/**
 * Models frequently wrap a JSON payload in a markdown code fence even when
 * instructed not to. When the entire payload is exactly one fenced block
 * whose content carries no fence of its own, unwrap it; anything ambiguous
 * stays unwrapped and fails the strict JSON parse below. Validation is
 * unchanged — this only normalizes the container.
 */
function unwrapCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  if (match === null || (match[1] as string).includes('```')) return trimmed;
  return match[1] as string;
}

/** Parses the raw model text as exactly one review document. */
export function parseFileReviewDocument(raw: string): FileReviewDocument {
  let decoded: unknown;
  try {
    decoded = JSON.parse(unwrapCodeFence(raw)) as unknown;
  } catch {
    throw new Error('review document is not valid JSON');
  }
  if (!isRecord(decoded)) throw new Error('review document must be an object');
  assertOnlyKeys(decoded, ['version', 'fileId', 'outcome', 'reason', 'findings'], 'review document');
  if (decoded.version !== FILE_REVIEW_DOCUMENT_VERSION) {
    throw new Error('review document uses an unsupported version');
  }
  const fileId = boundedString(decoded.fileId, 'review document.fileId', 6);
  const outcome = enumValue(decoded.outcome, OUTCOMES, 'review document.outcome');
  // Envelope tolerances for local and small models (the v2 schema is
  // enforced on everything that carries meaning): a reason on a
  // non-omitted outcome is dropped — only omission carries a reason in
  // records — and an absent findings array on a non-findings outcome
  // defaults to empty. Findings themselves, span anchoring, and evidence
  // keep full strict validation.
  let reason: string | undefined;
  if (decoded.reason !== undefined) {
    const provided = boundedString(decoded.reason, 'review document.reason', 500);
    if (outcome === 'omitted') reason = provided;
  }
  if (outcome === 'omitted' && reason === undefined) {
    throw new Error('review document.reason is required when the outcome is omitted');
  }
  const rawFindings = decoded.findings === undefined && outcome !== 'findings' ? [] : decoded.findings;
  if (!Array.isArray(rawFindings)) throw new Error('review document.findings must be an array');
  if (rawFindings.length > MAX_FILE_FINDINGS) {
    throw new Error(`review document.findings exceeds the ${MAX_FILE_FINDINGS}-finding limit`);
  }
  const findings = rawFindings.map((item) => parseFinding(item));
  if (outcome === 'clean' && findings.length > 0) {
    throw new Error('clean outcome is inconsistent with findings');
  }
  if (outcome === 'findings' && findings.length === 0) {
    throw new Error('findings outcome requires at least one finding');
  }
  return Object.freeze({ version: FILE_REVIEW_DOCUMENT_VERSION, fileId, outcome, reason, findings });
}

/**
 * A unified diff mapped to its lines: `left` holds removed lines keyed by
 * old-file line number, `right` holds added lines keyed by new-file line
 * number, and the context maps hold the unchanged lines each side carries
 * inside hunks, keyed per side (context lines sit at different numbers on
 * the two sides when a hunk adds or removes lines above them).
 */
export interface ChangedLines {
  readonly left: ReadonlyMap<number, string>;
  readonly right: ReadonlyMap<number, string>;
  readonly contextLeft: ReadonlyMap<number, string>;
  readonly contextRight: ReadonlyMap<number, string>;
}

/**
 * Maps a unified diff to its changed lines and hunk context lines.
 */
export function parseChangedLines(diff: string, label: string): ChangedLines {
  const left = new Map<number, string>();
  const right = new Map<number, string>();
  const contextLeft = new Map<number, string>();
  const contextRight = new Map<number, string>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(rawLine);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1] as string, 10);
      newLine = Number.parseInt(hunk[2] as string, 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (rawLine.startsWith('@@ ')) throw new Error(`${label} contains a malformed hunk header`);
    const marker = rawLine[0];
    const content = rawLine.slice(1);
    if (marker === ' ') {
      contextLeft.set(oldLine, content);
      contextRight.set(newLine, content);
      oldLine += 1;
      newLine += 1;
    } else if (marker === '-') {
      left.set(oldLine, content);
      oldLine += 1;
    } else if (marker === '+') {
      right.set(newLine, content);
      newLine += 1;
    } else if (marker === '\\') {
      continue;
    } else {
      inHunk = false;
    }
  }

  return { left, right, contextLeft, contextRight };
}

function stableFindingId(finding: ReviewFinding, manifestFile: ReviewManifestFile): string {
  const normalized = JSON.stringify({
    category: finding.category,
    classification: finding.classification,
    severity: finding.severity,
    confidence: finding.confidence,
    fileId: manifestFile.id,
    path: manifestFile.newPath ?? manifestFile.oldPath,
    side: finding.side,
    startLine: finding.startLine,
    endLine: finding.endLine,
    evidence: finding.evidence,
    impact: finding.impact,
    fix: finding.fix,
  });
  return `f-${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * Validates findings for one file against its manifest entry and the
 * authoritative diff. A finding is accepted only when both span endpoints
 * resolve to changed lines on the claimed side and its evidence is
 * byte-identical to the start line of that side.
 */
export class FileReviewValidator {
  readonly changed: ChangedLines;
  readonly #manifestFile: ReviewManifestFile;
  readonly #findingScope: FindingScope;

  constructor(manifestFile: ReviewManifestFile, diff: string, findingScope: FindingScope) {
    this.#manifestFile = manifestFile;
    this.changed = parseChangedLines(diff, manifestFile.diffFile);
    this.#findingScope = findingScope;
  }

  get path(): string {
    return this.#manifestFile.newPath ?? this.#manifestFile.oldPath ?? this.#manifestFile.id;
  }

  validateFinding(finding: ReviewFinding): ValidatedFinding {
    const manifestFile = this.#manifestFile;
    if (manifestFile.binary) throw new Error('finding cannot target a binary diff');
    if (this.#findingScope === 'defects' && finding.classification === 'risk') {
      throw new Error('risk finding is disabled by the configured finding scope');
    }
    const changed = finding.side === 'RIGHT' ? this.changed.right : this.changed.left;
    const startEvidence = changed.get(finding.startLine);
    if (startEvidence === undefined) {
      throw new Error('finding startLine is not a changed line in the authoritative diff');
    }
    if (changed.get(finding.endLine) === undefined) {
      throw new Error('finding endLine is not a changed line in the authoritative diff');
    }
    if (finding.evidence !== startEvidence) {
      throw new Error('finding evidence does not match the authoritative diff line');
    }
    return { ...finding, id: stableFindingId(finding, manifestFile) };
  }

  /** Validates and deduplicates the findings of one review document. */
  validateFindings(findings: readonly ReviewFinding[]): readonly ValidatedFinding[] {
    const validated: ValidatedFinding[] = [];
    const seen = new Set<string>();
    for (const finding of findings) {
      const checked = this.validateFinding(finding);
      if (seen.has(checked.id)) continue;
      seen.add(checked.id);
      validated.push(checked);
    }
    return validated;
  }
}
