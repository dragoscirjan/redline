/**
 * Parses untrusted per-file review documents and validates changed-line
 * triggers against the authoritative diff. Candidate failures are isolated:
 * one malformed or ungrounded finding cannot erase unrelated valid ones.
 */

import { createHash } from 'node:crypto';
import { codeContextGraphFactDigest } from '../code-context/artifact.js';
import { assertOnlyKeys, isRecord, type ReviewManifestFile } from './bundle.js';
import type {
  EvidenceRole,
  FindingCategory,
  FindingClassification,
  FindingReversibility,
  FindingScope,
  FindingSeverity,
  FindingSide,
  GraphReference,
  ImpactPath,
  RejectedCandidate,
  RemediationStatus,
  ReviewDimension,
  ReviewFinding,
  SourceEvidence,
  ValidatedFinding,
} from './types.js';

export const FILE_REVIEW_DOCUMENT_VERSION = 3 as const;
export const LEGACY_FILE_REVIEW_DOCUMENT_VERSION = 2 as const;
export const MAX_FILE_FINDINGS = 10;
export const MAX_SUGGESTED_CHANGE_CHARS = 8 * 1024;

const CATEGORIES = ['correctness', 'security', 'regression', 'testing', 'operational', 'maintainability'] as const;
const DIMENSIONS = [...CATEGORIES, 'compatibility', 'data-integrity', 'architecture'] as const;
const CLASSIFICATIONS = ['defect', 'risk', 'test-gap', 'design-debt', 'question'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const SIDES = ['LEFT', 'RIGHT'] as const;
const OUTCOMES = ['clean', 'findings', 'omitted'] as const;
const EVIDENCE_ROLES = ['missing-guard', 'caller-assumption', 'contract', 'schema', 'test-gap', 'impact-path'] as const;
const REVERSIBILITY = ['reversible', 'partially-reversible', 'irreversible', 'unknown'] as const;
const GRAPH_RESOLUTIONS = ['exact', 'approximate', 'unresolved'] as const;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_SUPPORTING_EVIDENCE = 12;
const MAX_GRAPH_REFERENCES = 8;
const MAX_IMPACT_PATH_STEPS = 16;
const MAX_TEXT_LIST = 8;

export interface FileReviewDocument {
  readonly version: typeof FILE_REVIEW_DOCUMENT_VERSION | typeof LEGACY_FILE_REVIEW_DOCUMENT_VERSION;
  readonly fileId: string;
  readonly outcome: 'clean' | 'findings' | 'omitted';
  readonly reason: string | undefined;
  readonly findings: readonly ReviewFinding[];
  /** Original raw-array index for each successfully parsed finding. */
  readonly candidateIndices: readonly number[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
}

export interface CandidateValidationResult {
  readonly findings: readonly ValidatedFinding[];
  /** Original raw-array index for each validated finding. */
  readonly candidateIndices: readonly number[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
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

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function lineRange(value: Record<string, unknown>, label: string): { startLine: number; endLine: number } {
  const startLine = positiveInteger(value.startLine, `${label}.startLine`);
  const endLine = positiveInteger(value.endLine, `${label}.endLine`);
  if (startLine > endLine) throw new Error(`${label}.startLine must not exceed endLine`);
  return { startLine, endLine };
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_TEXT_LIST) throw new Error(`${label} must be a bounded array`);
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, 1_024));
}

function enumList<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): readonly T[number][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > values.length) {
    throw new Error(`${label} must be a non-empty bounded array`);
  }
  const parsed = value.map((item, index) => enumValue(item, values, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label} must be unique`);
  return parsed;
}

function parseSourceEvidence(value: unknown, label: string): SourceEvidence {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, ['role', 'revision', 'path', 'startLine', 'endLine', 'evidence'], label);
  const revision = boundedString(value.revision, `${label}.revision`, 64);
  if (!COMMIT_PATTERN.test(revision)) throw new Error(`${label}.revision must be a full commit identifier`);
  const range = lineRange(value, label);
  return {
    role: enumValue(value.role, EVIDENCE_ROLES, `${label}.role`) as EvidenceRole,
    revision,
    path: boundedString(value.path, `${label}.path`, 4_096),
    ...range,
    evidence: boundedString(value.evidence, `${label}.evidence`, 4_096),
  };
}

export function graphReferenceDigest(
  reference: Omit<GraphReference, 'graphFactDigest'>,
): `sha256:${string}` {
  return codeContextGraphFactDigest(reference);
}

function parseGraphReference(value: unknown, label: string): GraphReference {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(
    value,
    [
      'provider',
      'providerVersion',
      'snapshotRevision',
      'capability',
      'query',
      'relationship',
      'resolution',
      'graphFactDigest',
    ],
    label,
  );
  const snapshotRevision = boundedString(value.snapshotRevision, `${label}.snapshotRevision`, 64);
  if (!COMMIT_PATTERN.test(snapshotRevision)) {
    throw new Error(`${label}.snapshotRevision must be a full commit identifier`);
  }
  const graphFactDigest = boundedString(value.graphFactDigest, `${label}.graphFactDigest`, 71);
  if (!SHA256_PATTERN.test(graphFactDigest)) throw new Error(`${label}.graphFactDigest must be sha256`);
  const reference: GraphReference = {
    provider: boundedString(value.provider, `${label}.provider`, 64),
    providerVersion: boundedString(value.providerVersion, `${label}.providerVersion`, 128),
    snapshotRevision,
    capability: boundedString(value.capability, `${label}.capability`, 128),
    query: boundedString(value.query, `${label}.query`, 2_048),
    relationship: boundedString(value.relationship, `${label}.relationship`, 256),
    resolution: enumValue(value.resolution, GRAPH_RESOLUTIONS, `${label}.resolution`),
    graphFactDigest: graphFactDigest as `sha256:${string}`,
  };
  if (reference.graphFactDigest !== graphReferenceDigest(reference)) {
    throw new Error(`${label}.graphFactDigest does not match the graph fact identity`);
  }
  return reference;
}

function parseImpactPath(
  value: unknown,
  supportingEvidenceCount: number,
  graphReferenceCount: number,
): ImpactPath {
  if (!isRecord(value)) throw new Error('finding.impactPath must be an object');
  assertOnlyKeys(value, ['status', 'steps', 'limitation'], 'finding.impactPath');
  const status = enumValue(value.status, ['complete', 'partial', 'unresolved'] as const, 'finding.impactPath.status');
  if (!Array.isArray(value.steps) || value.steps.length > MAX_IMPACT_PATH_STEPS) {
    throw new Error('finding.impactPath.steps must be a bounded array');
  }
  const steps = value.steps.map((item, index) => {
    const label = `finding.impactPath.steps[${index}]`;
    if (!isRecord(item)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(item, ['from', 'to', 'relationship', 'evidence', 'referenceIndex'], label);
    const evidence = enumValue(item.evidence, ['source', 'graph'] as const, `${label}.evidence`);
    const referenceIndex = nonNegativeInteger(item.referenceIndex, `${label}.referenceIndex`);
    const available = evidence === 'source' ? supportingEvidenceCount : graphReferenceCount;
    if (referenceIndex >= available) throw new Error(`${label}.referenceIndex is out of range`);
    return {
      from: boundedString(item.from, `${label}.from`, 512),
      to: boundedString(item.to, `${label}.to`, 512),
      relationship: boundedString(item.relationship, `${label}.relationship`, 512),
      evidence,
      referenceIndex,
    };
  });
  if (status === 'complete' && steps.length === 0) {
    throw new Error('finding.impactPath.steps must not be empty when status is complete');
  }
  const limitation = value.limitation === undefined
    ? undefined
    : boundedString(value.limitation, 'finding.impactPath.limitation', 2_048);
  if (status !== 'complete' && limitation === undefined) {
    throw new Error('finding.impactPath.limitation is required unless status is complete');
  }
  return { status, steps, ...(limitation === undefined ? {} : { limitation }) };
}

function parseRichFinding(value: unknown): ReviewFinding {
  if (!isRecord(value)) throw new Error('finding must be an object');
  assertOnlyKeys(
    value,
    [
      'title',
      'dimensions',
      'category',
      'classification',
      'severity',
      'confidence',
      'side',
      'startLine',
      'endLine',
      'evidence',
      'supportingEvidence',
      'graphReferences',
      'impactPath',
      'behavioralContract',
      'failureScenario',
      'reachability',
      'rootCause',
      'impact',
      'blastRadius',
      'reversibility',
      'assumptions',
      'counterEvidence',
      'uncertainty',
      'fix',
      'regressionTest',
      'verification',
      'remediationStatus',
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
  const range = lineRange(value, 'finding');
  if (!Array.isArray(value.supportingEvidence) || value.supportingEvidence.length > MAX_SUPPORTING_EVIDENCE) {
    throw new Error('finding.supportingEvidence must be a bounded array');
  }
  if (!Array.isArray(value.graphReferences) || value.graphReferences.length > MAX_GRAPH_REFERENCES) {
    throw new Error('finding.graphReferences must be a bounded array');
  }
  if (!isRecord(value.verification)) throw new Error('finding.verification must be an object');
  assertOnlyKeys(value.verification, ['status', 'reason'], 'finding.verification');
  if (value.verification.status !== 'unverified') {
    throw new Error('finding.verification.status must be unverified during discovery');
  }
  const remediationStatus = enumValue(
    value.remediationStatus,
    ['guidance', 'proposed'] as const,
    'finding.remediationStatus',
  ) as RemediationStatus;
  const supportingEvidence = value.supportingEvidence.map((item, index) =>
    parseSourceEvidence(item, `finding.supportingEvidence[${index}]`));
  const graphReferences = value.graphReferences.map((item, index) =>
    parseGraphReference(item, `finding.graphReferences[${index}]`));
  const impactPath = parseImpactPath(value.impactPath, supportingEvidence.length, graphReferences.length);
  const suggestedChange = value.suggestedChange === undefined
    ? undefined
    : boundedString(value.suggestedChange, 'finding.suggestedChange', MAX_SUGGESTED_CHANGE_CHARS);
  return {
    title: boundedString(value.title, 'finding.title', 200),
    dimensions: enumList(value.dimensions, DIMENSIONS, 'finding.dimensions') as readonly ReviewDimension[],
    category: enumValue(value.category, CATEGORIES, 'finding.category') as FindingCategory,
    classification: enumValue(value.classification, CLASSIFICATIONS, 'finding.classification') as FindingClassification,
    severity: enumValue(value.severity, SEVERITIES, 'finding.severity') as FindingSeverity,
    confidence: value.confidence,
    side: enumValue(value.side, SIDES, 'finding.side') as FindingSide,
    ...range,
    evidence: boundedString(value.evidence, 'finding.evidence', 4_096),
    supportingEvidence,
    graphReferences,
    impactPath,
    behavioralContract: boundedString(value.behavioralContract, 'finding.behavioralContract', 4_096),
    failureScenario: boundedString(value.failureScenario, 'finding.failureScenario', 4_096),
    reachability: boundedString(value.reachability, 'finding.reachability', 4_096),
    rootCause: boundedString(value.rootCause, 'finding.rootCause', 4_096),
    impact: boundedString(value.impact, 'finding.impact', 4_096),
    blastRadius: boundedString(value.blastRadius, 'finding.blastRadius', 4_096),
    reversibility: enumValue(value.reversibility, REVERSIBILITY, 'finding.reversibility') as FindingReversibility,
    assumptions: stringList(value.assumptions, 'finding.assumptions'),
    counterEvidence: stringList(value.counterEvidence, 'finding.counterEvidence'),
    uncertainty: boundedString(value.uncertainty, 'finding.uncertainty', 4_096),
    fix: boundedString(value.fix, 'finding.fix', 4_096),
    regressionTest: boundedString(value.regressionTest, 'finding.regressionTest', 4_096),
    verification: {
      status: 'unverified',
      reason: boundedString(value.verification.reason, 'finding.verification.reason', 1_024),
    },
    remediationStatus,
    ...(suggestedChange !== undefined ? { suggestedChange } : {}),
  };
}

function parseLegacyFinding(value: unknown): ReviewFinding {
  if (!isRecord(value)) throw new Error('finding must be an object');
  assertOnlyKeys(
    value,
    ['category', 'classification', 'severity', 'confidence', 'side', 'startLine', 'endLine', 'evidence', 'impact', 'fix', 'suggestedChange'],
    'finding',
  );
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new Error('finding.confidence must be between 0 and 1');
  }
  const range = lineRange(value, 'finding');
  const category = enumValue(value.category, CATEGORIES, 'finding.category') as FindingCategory;
  const classification = enumValue(value.classification, ['defect', 'risk'] as const, 'finding.classification');
  const impact = boundedString(value.impact, 'finding.impact', 4_096);
  const fix = boundedString(value.fix, 'finding.fix', 4_096);
  const suggestedChange = value.suggestedChange === undefined
    ? undefined
    : boundedString(value.suggestedChange, 'finding.suggestedChange', MAX_SUGGESTED_CHANGE_CHARS);
  return {
    title: `${classification === 'defect' ? 'Defect' : 'Risk'}: ${impact.slice(0, 160)}`,
    dimensions: [category],
    category,
    classification,
    severity: enumValue(value.severity, SEVERITIES, 'finding.severity') as FindingSeverity,
    confidence: value.confidence,
    side: enumValue(value.side, SIDES, 'finding.side') as FindingSide,
    ...range,
    evidence: boundedString(value.evidence, 'finding.evidence', 4_096),
    supportingEvidence: [],
    graphReferences: [],
    impactPath: {
      status: 'unresolved',
      steps: [],
      limitation: 'Legacy v2 review document did not include a validated impact path.',
    },
    behavioralContract: 'Legacy v2 review document did not state the behavioral contract separately.',
    failureScenario: impact,
    reachability: 'Legacy v2 review document did not state reachability separately.',
    rootCause: impact,
    impact,
    blastRadius: impact,
    reversibility: 'unknown',
    assumptions: [],
    counterEvidence: [],
    uncertainty: 'Legacy v2 review document omitted structured uncertainty.',
    fix,
    regressionTest: 'Add a regression test that reproduces the stated impact before the fix and passes after it.',
    verification: { status: 'unverified', reason: 'Independent verification has not run.' },
    remediationStatus: suggestedChange === undefined ? 'guidance' : 'proposed',
    ...(suggestedChange !== undefined ? { suggestedChange } : {}),
  };
}

function unwrapCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  return match === null ? trimmed : (match[1] as string);
}

function rejection(index: number, stage: RejectedCandidate['stage'], code: string, error: unknown): RejectedCandidate {
  const message = error instanceof Error ? error.message : String(error);
  return { index, stage, code, reason: message.slice(0, 500) };
}

/** Parses one v3 document or intentionally migrates a v2 document in memory. */
export function parseFileReviewDocument(raw: string): FileReviewDocument {
  let decoded: unknown;
  try {
    decoded = JSON.parse(unwrapCodeFence(raw)) as unknown;
  } catch {
    throw new Error('review document is not valid JSON');
  }
  if (!isRecord(decoded)) throw new Error('review document must be an object');
  assertOnlyKeys(decoded, ['version', 'fileId', 'outcome', 'reason', 'findings'], 'review document');
  if (decoded.version !== FILE_REVIEW_DOCUMENT_VERSION && decoded.version !== LEGACY_FILE_REVIEW_DOCUMENT_VERSION) {
    throw new Error('review document uses an unsupported version');
  }
  const version = decoded.version;
  const fileId = boundedString(decoded.fileId, 'review document.fileId', 6);
  const outcome = enumValue(decoded.outcome, OUTCOMES, 'review document.outcome');
  let reason: string | undefined;
  if ((typeof decoded.reason === 'string' && decoded.reason.trim().length === 0) || decoded.reason === null) {
    // Empty omission reasons are treated as absent.
  } else if (decoded.reason !== undefined) {
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
  if (outcome === 'clean' && rawFindings.length > 0) {
    throw new Error('clean outcome is inconsistent with candidate findings');
  }
  if (outcome === 'findings' && rawFindings.length === 0) {
    throw new Error('findings outcome requires at least one candidate finding');
  }

  const findings: ReviewFinding[] = [];
  const candidateIndices: number[] = [];
  const rejectedCandidates: RejectedCandidate[] = [];
  rawFindings.forEach((item, index) => {
    try {
      findings.push(version === FILE_REVIEW_DOCUMENT_VERSION ? parseRichFinding(item) : parseLegacyFinding(item));
      candidateIndices.push(index);
    } catch (error) {
      rejectedCandidates.push(rejection(index, 'parse', 'candidate-schema-invalid', error));
    }
  });
  return Object.freeze({ version, fileId, outcome, reason, findings, candidateIndices, rejectedCandidates });
}

export interface ChangedLines {
  readonly left: ReadonlyMap<number, string>;
  readonly right: ReadonlyMap<number, string>;
  readonly contextLeft: ReadonlyMap<number, string>;
  readonly contextRight: ReadonlyMap<number, string>;
}

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
    ...finding,
    suggestedChange: undefined,
    fileId: manifestFile.id,
    path: manifestFile.newPath ?? manifestFile.oldPath,
  });
  return `f-${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24)}`;
}

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
    if (this.#manifestFile.binary) throw new Error('finding cannot target a binary diff');
    if (
      this.#findingScope === 'defects'
      && (finding.classification === 'risk' || finding.classification === 'design-debt')
    ) {
      throw new Error(`${finding.classification} finding is disabled by the configured finding scope`);
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
    return { ...finding, id: stableFindingId(finding, this.#manifestFile) };
  }

  validateCandidates(
    findings: readonly ReviewFinding[],
    candidateIndices: readonly number[] = findings.map((_finding, index) => index),
  ): CandidateValidationResult {
    if (candidateIndices.length !== findings.length) {
      throw new Error('candidate index mapping does not match parsed findings');
    }
    const checked: Array<{ finding: ValidatedFinding; index: number }> = [];
    const rejectedCandidates: RejectedCandidate[] = [];
    findings.forEach((finding, position) => {
      const index = candidateIndices[position] as number;
      try {
        checked.push({ finding: this.validateFinding(finding), index });
      } catch (error) {
        rejectedCandidates.push(rejection(index, 'validation', 'candidate-trigger-invalid', error));
      }
    });

    const byTrigger = new Map<string, Array<{ finding: ValidatedFinding; index: number }>>();
    for (const item of checked) {
      const key = JSON.stringify({
        side: item.finding.side,
        startLine: item.finding.startLine,
        endLine: item.finding.endLine,
        evidence: item.finding.evidence,
      });
      const group = byTrigger.get(key) ?? [];
      group.push(item);
      byTrigger.set(key, group);
    }

    const validated: ValidatedFinding[] = [];
    const validatedIndices: number[] = [];
    for (const triggerGroup of byTrigger.values()) {
      const exact = new Map<string, { finding: ValidatedFinding; index: number }>();
      for (const item of triggerGroup) {
        if (!exact.has(item.finding.id)) exact.set(item.finding.id, item);
      }

      const byClaim = new Map<string, Array<{ finding: ValidatedFinding; index: number }>>();
      for (const item of exact.values()) {
        const title = item.finding.title.trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
        const key = JSON.stringify({ category: item.finding.category, title });
        const group = byClaim.get(key) ?? [];
        group.push(item);
        byClaim.set(key, group);
      }

      for (const claimGroup of byClaim.values()) {
        const classifications = new Set(claimGroup.map((item) => item.finding.classification));
        const severities = new Set(claimGroup.map((item) => item.finding.severity));
        if (classifications.size > 1 || severities.size > 1) {
          for (const item of claimGroup) {
            rejectedCandidates.push({
              index: item.index,
              stage: 'validation',
              code: 'candidate-conflict',
              reason: 'candidates with the same root-cause identity claim incompatible classification or severity',
            });
          }
          continue;
        }
        for (const item of claimGroup) {
          validated.push(item.finding);
          validatedIndices.push(item.index);
        }
      }
    }
    return { findings: validated, candidateIndices: validatedIndices, rejectedCandidates };
  }

  /** Compatibility helper for callers that still require all-or-nothing validation. */
  validateFindings(findings: readonly ReviewFinding[]): readonly ValidatedFinding[] {
    return findings.map((finding) => this.validateFinding(finding));
  }
}
