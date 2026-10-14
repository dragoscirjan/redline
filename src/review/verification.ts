/** Bounded, source-backed dispositions from one fresh verifier invocation per file. */

import type { ReviewBundle, ReviewManifestFile } from './bundle.js';
import { validateSourceEvidence } from './source-evidence.js';
import type {
  FindingClassification,
  FindingScope,
  FindingSeverity,
  SourceEvidence,
  ValidatedFinding,
} from './types.js';

export const VERIFICATION_DOCUMENT_VERSION = 1 as const;
export const MAX_VERIFICATION_DOCUMENT_BYTES = 64 * 1024;
const MAX_VERIFICATION_CITATIONS = 4;
const MAX_SUPPORTING_EVIDENCE = 12;
const ID_PATTERN = /^f-[0-9a-f]{24}$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CLASSIFICATIONS = new Set<FindingClassification>(['defect', 'risk', 'test-gap', 'design-debt', 'question']);
const SEVERITIES = new Set<FindingSeverity>(['critical', 'high', 'medium', 'low']);
const ROLES = new Set<SourceEvidence['role']>([
  'missing-guard', 'caller-assumption', 'contract', 'schema', 'test-gap', 'impact-path',
]);

export type VerificationDisposition =
  | 'confirmed' | 'reclassified' | 'human-question' | 'rejected' | 'duplicate' | 'inconclusive';

export interface VerificationResult {
  readonly candidateId: string;
  readonly disposition: VerificationDisposition;
  readonly reason: string;
  readonly citations: readonly SourceEvidence[];
  readonly classification?: FindingClassification | undefined;
  readonly severity?: FindingSeverity | undefined;
  readonly duplicateOf?: string | undefined;
}

export interface VerificationDocument {
  readonly version: typeof VERIFICATION_DOCUMENT_VERSION;
  readonly fileId: string;
  readonly results: readonly VerificationResult[];
}

export interface VerifiedDisposition extends VerificationResult {
  readonly finding?: ValidatedFinding | undefined;
}

function object(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error(`${label} has unsupported fields`);
  return record;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function citation(value: unknown): SourceEvidence {
  const entry = object(value, 'verifier citation', ['role', 'revision', 'path', 'startLine', 'endLine', 'evidence']);
  if (!ROLES.has(entry['role'] as SourceEvidence['role'])) throw new Error('verifier citation role is unsupported');
  const revision = text(entry['revision'], 'verifier citation revision', 64);
  if (!COMMIT_PATTERN.test(revision)) throw new Error('verifier citation revision is invalid');
  const startLine = positive(entry['startLine'], 'verifier citation startLine');
  const endLine = positive(entry['endLine'], 'verifier citation endLine');
  if (endLine < startLine || endLine - startLine >= 80) throw new Error('verifier citation range is invalid');
  return {
    role: entry['role'] as SourceEvidence['role'],
    revision,
    path: text(entry['path'], 'verifier citation path', 4_096),
    startLine,
    endLine,
    evidence: text(entry['evidence'], 'verifier citation evidence', 4_096),
  };
}

function result(value: unknown): VerificationResult {
  const entry = object(value, 'verifier result', [
    'candidateId', 'disposition', 'reason', 'citations', 'classification', 'severity', 'duplicateOf',
  ]);
  const candidateId = text(entry['candidateId'], 'verifier candidateId', 26);
  if (!ID_PATTERN.test(candidateId)) throw new Error('verifier candidateId is invalid');
  const disposition = entry['disposition'];
  if (![
    'confirmed', 'reclassified', 'human-question', 'rejected', 'duplicate', 'inconclusive',
  ].includes(disposition as string)) throw new Error('verifier disposition is unsupported');
  const citations = entry['citations'];
  if (!Array.isArray(citations) || citations.length > MAX_VERIFICATION_CITATIONS) {
    throw new Error('verifier citations must be a bounded array');
  }
  const classification = entry['classification'];
  if (classification !== undefined && !CLASSIFICATIONS.has(classification as FindingClassification)) {
    throw new Error('verifier classification is unsupported');
  }
  const severity = entry['severity'];
  if (severity !== undefined && !SEVERITIES.has(severity as FindingSeverity)) {
    throw new Error('verifier severity is unsupported');
  }
  const duplicateOf = entry['duplicateOf'];
  if (duplicateOf !== undefined && (typeof duplicateOf !== 'string' || !ID_PATTERN.test(duplicateOf))) {
    throw new Error('verifier duplicateOf is invalid');
  }
  if ((disposition === 'duplicate') !== (duplicateOf !== undefined)) {
    throw new Error('verifier duplicateOf must identify only a duplicate');
  }
  if (
    disposition !== 'reclassified' && disposition !== 'human-question'
    && (classification !== undefined || severity !== undefined)
  ) throw new Error('verifier cannot modify an unchanged or unpublished candidate');
  if (disposition === 'human-question' && classification !== 'question') {
    throw new Error('verifier human question must use question classification');
  }
  return {
    candidateId,
    disposition: disposition as VerificationDisposition,
    reason: text(entry['reason'], 'verifier reason', 500),
    citations: citations.map(citation),
    ...(classification === undefined ? {} : { classification: classification as FindingClassification }),
    ...(severity === undefined ? {} : { severity: severity as FindingSeverity }),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
  };
}

/** Rejects incomplete, duplicated, or extra candidate dispositions as one file-level failure. */
export function parseVerificationDocument(
  raw: string,
  fileId: string,
  candidates: readonly ValidatedFinding[],
): VerificationDocument {
  if (Buffer.byteLength(raw, 'utf8') > MAX_VERIFICATION_DOCUMENT_BYTES) {
    throw new Error('verifier document exceeds its byte limit');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('verifier document must be valid JSON');
  }
  const input = object(decoded, 'verifier document', ['version', 'fileId', 'results']);
  if (input['version'] !== VERIFICATION_DOCUMENT_VERSION || input['fileId'] !== fileId) {
    throw new Error('verifier document version or file identity does not match');
  }
  if (!Array.isArray(input['results']) || input['results'].length !== candidates.length) {
    throw new Error('verifier must dispose exactly the validated candidates');
  }
  const results = input['results'].map(result);
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  if (candidateIds.size !== candidates.length) throw new Error('validated candidate identities must be unique');
  const resultIds = new Set(results.map((entry) => entry.candidateId));
  if (resultIds.size !== candidateIds.size || [...resultIds].some((id) => !candidateIds.has(id))) {
    throw new Error('verifier result identities do not match validated candidates');
  }
  for (const entry of results) {
    if (entry.duplicateOf !== undefined && (
      entry.duplicateOf === entry.candidateId || !candidateIds.has(entry.duplicateOf)
    )) throw new Error('verifier duplicate does not identify another validated candidate');
  }
  return { version: VERIFICATION_DOCUMENT_VERSION, fileId, results };
}

function sameCitation(left: SourceEvidence, right: SourceEvidence): boolean {
  return left.revision === right.revision
    && left.path === right.path
    && left.startLine === right.startLine
    && left.endLine === right.endLine
    && left.evidence === right.evidence;
}

/** A model cannot create a new source authority: follow-up evidence needs action validation first. */
export async function validateVerificationDocument(
  bundle: ReviewBundle,
  file: ReviewManifestFile,
  candidates: readonly ValidatedFinding[],
  document: VerificationDocument,
  findingScope: FindingScope,
): Promise<readonly VerifiedDisposition[]> {
  if (document.fileId !== file.id || document.results.length !== candidates.length) {
    throw new Error('verifier document does not cover this file');
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const dispositions: VerifiedDisposition[] = [];
  for (const entry of document.results) {
    const candidate = byId.get(entry.candidateId);
    if (candidate === undefined) throw new Error('verifier references an unknown candidate');
    const publishable = entry.disposition === 'confirmed'
      || entry.disposition === 'reclassified' || entry.disposition === 'human-question';
    if (publishable && entry.citations.length === 0) throw new Error('publishable verifier result needs source evidence');
    const triggerPath = candidate.side === 'LEFT'
      ? file.oldPath ?? file.newPath
      : file.newPath ?? file.oldPath;
    if (triggerPath === null) throw new Error('verifier candidate has no trigger path');
    const trigger: SourceEvidence = {
      role: 'contract',
      revision: candidate.side === 'LEFT' ? bundle.manifest.base : bundle.manifest.head,
      path: triggerPath,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      evidence: candidate.evidence,
    };
    for (const evidence of entry.citations) {
      if (![trigger, ...candidate.supportingEvidence].some((known) => sameCitation(known, evidence))) {
        throw new Error('verifier citation is not a validated candidate source location');
      }
      await validateSourceEvidence(bundle, evidence);
    }
    if (!publishable) {
      dispositions.push(entry);
      continue;
    }
    const classification = entry.classification ?? candidate.classification;
    const severity = entry.severity ?? candidate.severity;
    if (entry.disposition === 'reclassified'
      && classification === candidate.classification && severity === candidate.severity) {
      throw new Error('verifier reclassification must change the classification or severity');
    }
    if (findingScope === 'defects' && (classification === 'risk' || classification === 'design-debt')) {
      throw new Error('verifier reclassification is outside the configured finding scope');
    }
    const additions = entry.citations.filter((item) => !sameCitation(item, trigger)
      && !candidate.supportingEvidence.some((known) => sameCitation(known, item)));
    if (candidate.supportingEvidence.length + additions.length > MAX_SUPPORTING_EVIDENCE) {
      throw new Error('verified supporting evidence exceeds the finding limit');
    }
    dispositions.push({
      ...entry,
      finding: {
        ...candidate,
        classification,
        severity,
        supportingEvidence: [...candidate.supportingEvidence, ...additions],
        verification: { status: 'confirmed', reason: entry.reason },
      },
    });
  }
  return dispositions;
}
