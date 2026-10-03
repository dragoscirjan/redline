import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FindingScope } from './review-prompt.js';
import {
  assertOnlyKeys,
  byteLength,
  isRecord,
  type ReviewBundle,
  type ReviewManifestFile,
} from './review-bundle.js';

export const REVIEW_EVENT_VERSION = 1 as const;
export const MAX_REVIEW_FINDINGS = 10;
export const MAX_REVIEW_EVENT_LINE_BYTES = 16 * 1024;
export const MAX_REVIEW_EVENT_STREAM_BYTES = 256 * 1024;

const CATEGORIES = ['correctness', 'security', 'regression', 'testing', 'operational', 'maintainability'] as const;
const CLASSIFICATIONS = ['defect', 'risk'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const SIDES = ['LEFT', 'RIGHT'] as const;
const OUTCOMES = ['clean', 'findings', 'incomplete'] as const;
const INCOMPLETE_REASONS = [
  'backend-timeout',
  'backend-failure',
  'coverage-incomplete',
  'publication-failure',
] as const;

type FindingCategory = (typeof CATEGORIES)[number];
type FindingClassification = (typeof CLASSIFICATIONS)[number];
type FindingSeverity = (typeof SEVERITIES)[number];
export type FindingSide = (typeof SIDES)[number];
export type ReviewOutcome = (typeof OUTCOMES)[number];
export type IncompleteReason = (typeof INCOMPLETE_REASONS)[number];

export interface ReviewFinding {
  category: FindingCategory;
  classification: FindingClassification;
  severity: FindingSeverity;
  confidence: number;
  fileId: string;
  path: string;
  side: FindingSide;
  line: number;
  evidence: string;
  impact: string;
  fix: string;
}

export interface ReviewFindingEvent {
  version: typeof REVIEW_EVENT_VERSION;
  type: 'finding';
  finding: ReviewFinding;
}

export interface ReviewCoverageOmission {
  fileId: string;
  reason: string;
}

export interface ReviewCapabilityFailure {
  capability: string;
  reason: string;
}

export interface ReviewCoverage {
  reviewedFileIds: string[];
  omitted: ReviewCoverageOmission[];
  capabilityFailures: ReviewCapabilityFailure[];
}

export interface ReviewCompletionEvent {
  version: typeof REVIEW_EVENT_VERSION;
  type: 'completion';
  outcome: ReviewOutcome;
  coverage: ReviewCoverage;
}

export type ReviewEvent = ReviewFindingEvent | ReviewCompletionEvent;

export interface ReviewCompletion {
  status: 'complete' | 'incomplete';
  reason?: IncompleteReason;
  message?: string;
}

export interface ValidatedFinding extends ReviewFinding {
  id: string;
}

interface ChangedLines {
  left: Map<number, string>;
  right: Map<number, string>;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`);
  if (byteLength(value) > maxBytes) throw new Error(`${label} exceeds its byte limit`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function parseFinding(value: unknown): ReviewFinding {
  if (!isRecord(value)) throw new Error('finding must be an object');
  assertOnlyKeys(
    value,
    ['category', 'classification', 'severity', 'confidence', 'fileId', 'path', 'side', 'line', 'evidence', 'impact', 'fix'],
    'finding',
  );
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) {
    throw new Error('finding.confidence must be a finite number');
  }
  if (value.confidence < 0 || value.confidence > 1) {
    throw new Error('finding.confidence must be between 0 and 1');
  }
  return {
    category: enumValue(value.category, CATEGORIES, 'finding.category'),
    classification: enumValue(value.classification, CLASSIFICATIONS, 'finding.classification'),
    severity: enumValue(value.severity, SEVERITIES, 'finding.severity'),
    confidence: value.confidence,
    fileId: boundedString(value.fileId, 'finding.fileId', 6),
    path: boundedString(value.path, 'finding.path', 4_096),
    side: enumValue(value.side, SIDES, 'finding.side'),
    line: positiveInteger(value.line, 'finding.line'),
    evidence: boundedString(value.evidence, 'finding.evidence', 4_096),
    impact: boundedString(value.impact, 'finding.impact', 4_096),
    fix: boundedString(value.fix, 'finding.fix', 4_096),
  };
}

function parseCoverage(value: unknown): ReviewCoverage {
  if (!isRecord(value)) throw new Error('completion.coverage must be an object');
  assertOnlyKeys(value, ['reviewedFileIds', 'omitted', 'capabilityFailures'], 'completion.coverage');
  if (!Array.isArray(value.reviewedFileIds)) throw new Error('completion.coverage.reviewedFileIds must be an array');
  if (!Array.isArray(value.omitted)) throw new Error('completion.coverage.omitted must be an array');
  if (!Array.isArray(value.capabilityFailures)) {
    throw new Error('completion.coverage.capabilityFailures must be an array');
  }
  if (value.reviewedFileIds.length > 2_000 || value.omitted.length > 2_000 || value.capabilityFailures.length > 32) {
    throw new Error('completion.coverage exceeds its item limit');
  }

  const reviewedFileIds = value.reviewedFileIds.map((item, index) =>
    boundedString(item, `completion.coverage.reviewedFileIds[${index}]`, 6),
  );
  const omitted = value.omitted.map((item, index): ReviewCoverageOmission => {
    const label = `completion.coverage.omitted[${index}]`;
    if (!isRecord(item)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(item, ['fileId', 'reason'], label);
    return {
      fileId: boundedString(item.fileId, `${label}.fileId`, 6),
      reason: boundedString(item.reason, `${label}.reason`, 1_024),
    };
  });
  const capabilityFailures = value.capabilityFailures.map((item, index): ReviewCapabilityFailure => {
    const label = `completion.coverage.capabilityFailures[${index}]`;
    if (!isRecord(item)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(item, ['capability', 'reason'], label);
    return {
      capability: boundedString(item.capability, `${label}.capability`, 128),
      reason: boundedString(item.reason, `${label}.reason`, 1_024),
    };
  });
  return { reviewedFileIds, omitted, capabilityFailures };
}

export function parseReviewEvent(value: unknown): ReviewEvent {
  if (!isRecord(value)) throw new Error('review event must be an object');
  if (value.version !== REVIEW_EVENT_VERSION) throw new Error('review event uses an unsupported version');
  if (value.type === 'finding') {
    assertOnlyKeys(value, ['version', 'type', 'finding'], 'finding event');
    return { version: REVIEW_EVENT_VERSION, type: 'finding', finding: parseFinding(value.finding) };
  }
  if (value.type === 'completion') {
    assertOnlyKeys(value, ['version', 'type', 'outcome', 'coverage'], 'completion event');
    return {
      version: REVIEW_EVENT_VERSION,
      type: 'completion',
      outcome: enumValue(value.outcome, OUTCOMES, 'completion.outcome'),
      coverage: parseCoverage(value.coverage),
    };
  }
  throw new Error('review event type is unsupported');
}

export function validateReviewCompletion(completion: ReviewCompletion): ReviewCompletion {
  if (completion.status === 'complete') {
    if (completion.reason !== undefined || completion.message !== undefined) {
      throw new Error('complete review cannot include an incomplete reason or message');
    }
    return completion;
  }
  if (completion.status !== 'incomplete') throw new Error('review completion status is unsupported');
  if (!completion.reason || !INCOMPLETE_REASONS.includes(completion.reason)) {
    throw new Error('incomplete review requires a supported reason');
  }
  if (completion.message !== undefined) {
    if (completion.message.length === 0) throw new Error('incomplete review message cannot be empty');
    if (completion.message.includes('\0')) throw new Error('incomplete review message contains a NUL byte');
    if ([...completion.message].length > 500) throw new Error('incomplete review message exceeds 500 characters');
  }
  return completion;
}

function parseChangedLines(diff: string, label: string): ChangedLines {
  const left = new Map<number, string>();
  const right = new Map<number, string>();
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

  return { left, right };
}

function stableFindingId(finding: ReviewFinding): string {
  const normalized = JSON.stringify({
    category: finding.category,
    classification: finding.classification,
    severity: finding.severity,
    confidence: finding.confidence,
    fileId: finding.fileId,
    path: finding.path,
    side: finding.side,
    line: finding.line,
    evidence: finding.evidence,
    impact: finding.impact,
    fix: finding.fix,
  });
  return `f-${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24)}`;
}

export class ReviewFindingValidator {
  readonly #files: Map<string, { manifest: ReviewManifestFile; changed: ChangedLines }>;
  readonly #fileIds: Set<string>;
  readonly #findingScope: FindingScope;
  readonly #omittedFileIds: Set<string>;

  private constructor(
    files: Map<string, { manifest: ReviewManifestFile; changed: ChangedLines }>,
    findingScope: FindingScope,
    omittedFileIds: readonly string[],
  ) {
    this.#files = files;
    this.#fileIds = new Set(files.keys());
    this.#findingScope = findingScope;
    this.#omittedFileIds = new Set([
      ...omittedFileIds,
      ...[...files.values()].filter((file) => file.manifest.binary).map((file) => file.manifest.id),
    ]);
    for (const id of this.#omittedFileIds) {
      if (!this.#fileIds.has(id)) throw new Error('omitted evidence contains an unknown file id');
    }
  }

  static async create(
    bundle: ReviewBundle,
    findingScope: FindingScope,
    omittedFileIds: readonly string[] = [],
  ): Promise<ReviewFindingValidator> {
    const files = new Map<string, { manifest: ReviewManifestFile; changed: ChangedLines }>();
    for (const manifest of bundle.manifest.files) {
      const diff = await readFile(`${bundle.root}/${manifest.diffFile}`, 'utf8');
      files.set(manifest.id, { manifest, changed: parseChangedLines(diff, manifest.diffFile) });
    }
    return new ReviewFindingValidator(files, findingScope, omittedFileIds);
  }

  validateFinding(finding: ReviewFinding): ValidatedFinding {
    const file = this.#files.get(finding.fileId);
    if (!file) throw new Error('finding.fileId is not present in the review manifest');
    if (file.manifest.binary) throw new Error('finding cannot target a binary diff');
    if (this.#omittedFileIds.has(finding.fileId)) throw new Error('finding diff was omitted from model-visible evidence');
    if (this.#findingScope === 'defects' && finding.classification === 'risk') {
      throw new Error('risk finding is disabled by the configured finding scope');
    }
    const expectedPath =
      finding.side === 'RIGHT' ? file.manifest.newPath : (file.manifest.oldPath ?? file.manifest.newPath);
    if (expectedPath === null || finding.path !== expectedPath) {
      throw new Error('finding path and side do not match the review manifest');
    }
    const changed = finding.side === 'RIGHT' ? file.changed.right : file.changed.left;
    const evidence = changed.get(finding.line);
    if (evidence === undefined) throw new Error('finding line is not a changed line in the authoritative diff');
    if (finding.evidence !== evidence) throw new Error('finding evidence does not match the authoritative diff line');
    return { ...finding, id: stableFindingId(finding) };
  }

  validateCompletion(event: ReviewCompletionEvent, findingCount: number): ReviewCompletionEvent {
    const reviewed = new Set(event.coverage.reviewedFileIds);
    const omitted = new Set(event.coverage.omitted.map((item) => item.fileId));
    if (reviewed.size !== event.coverage.reviewedFileIds.length || omitted.size !== event.coverage.omitted.length) {
      throw new Error('completion coverage repeats a file id');
    }
    for (const fileId of reviewed) {
      if (!this.#fileIds.has(fileId)) throw new Error('completion coverage contains an unknown reviewed file id');
      if (this.#omittedFileIds.has(fileId)) throw new Error('completion claims reviewed coverage for an omitted diff');
      if (omitted.has(fileId)) throw new Error('completion coverage reviewed and omitted sets overlap');
    }
    for (const fileId of omitted) {
      if (!this.#fileIds.has(fileId)) throw new Error('completion coverage contains an unknown omitted file id');
    }
    if (reviewed.size + omitted.size !== this.#fileIds.size) {
      throw new Error('completion coverage does not account for every manifest file');
    }
    const incomplete = omitted.size > 0 || event.coverage.capabilityFailures.length > 0;
    if (event.outcome === 'clean' && (incomplete || findingCount > 0)) {
      throw new Error('clean outcome is inconsistent with findings or incomplete coverage');
    }
    if (event.outcome === 'findings' && (incomplete || findingCount === 0)) {
      throw new Error('findings outcome is inconsistent with findings or incomplete coverage');
    }
    if (event.outcome === 'incomplete' && !incomplete) {
      throw new Error('incomplete outcome requires omitted coverage or a capability failure');
    }
    return event;
  }
}
