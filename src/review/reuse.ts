import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, opendir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CODE_CONTEXT_VERSION, codeContextGraphFactDigest } from '../code-context/artifact.ts';
import { assertOnlyKeys, isRecord, type ReviewBundle, type ReviewManifestFile } from './bundle.ts';
import type { ReviewEnvironment, ReviewReuseEnvironment } from './environment.ts';
import {
  codeContextForFile,
  type FileReviewCodeContext,
  type LoadedReviewCodeContext,
} from './indexed-context.ts';
import {
  buildFileContextPayload,
  buildFileReviewPrompt,
  FILE_REVIEW_PROMPT_ID,
  FILE_REVIEW_PROMPT_VERSION,
} from './prompt.ts';
import { validateFindingReferences } from './pr-contract.ts';
import {
  type ChangedLines,
  FILE_REVIEW_DOCUMENT_VERSION,
  FileReviewValidator,
  MAX_FILE_FINDINGS,
  parseReusableReviewFinding,
} from './report.ts';
import { buildRemediation, renderSuggestion, resolveSpanLines } from './remediation.ts';
import {
  FILE_REVIEW_RECORD_VERSION,
  MAX_PERSISTED_REVIEW_REASON_CHARS,
  MAX_REVIEW_REASON_CHARS,
  type FileFollowUpCoverage,
  type FileReviewRecord,
  type FileVerificationCoverage,
  type PublishedFinding,
  type RejectedCandidate,
  type ReviewFinding,
  type ValidatedFinding,
} from './types.ts';
import { VERIFICATION_DOCUMENT_VERSION } from './verification.ts';
import {
  loadVerificationPolicy,
  VERIFICATION_PROMPT_ID,
} from './verification-prompt.ts';

export const REVIEW_REUSE_CACHE_VERSION = 2 as const;
export const REVIEW_SEMANTIC_FINGERPRINT_VERSION = 1 as const;
export const REVIEW_REUSE_TELEMETRY_VERSION = 1 as const;

const MAX_REUSE_ENTRIES = 2_000;
const MAX_REUSE_ENTRY_BYTES = 512 * 1024;
const MAX_REUSE_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_REUSE_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_REJECTED_CANDIDATES = 32;
/** Rendered diff suggestions include bounded current and proposed lines. */
const MAX_CACHED_SUGGESTION_CHARS = 32 * 1024;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CACHE_FILE_PATTERN = /^[0-9a-f]{64}\.json$/u;

interface CachedReviewFinding {
  readonly finding: ReviewFinding;
  readonly suggestion: string | null;
}

interface CachedReviewResult {
  readonly outcome: 'clean' | 'findings';
  readonly reason?: string | undefined;
  readonly findings: readonly CachedReviewFinding[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
  readonly verification?: FileVerificationCoverage | undefined;
  readonly followUp?: FileFollowUpCoverage | undefined;
  readonly executionDurationMs: number;
}

export interface ReviewReuseCandidate {
  readonly path: string;
  readonly base: string;
  readonly head: string;
  readonly fingerprint: string;
  readonly result: CachedReviewResult;
}

interface StoredReviewReuseEntry extends ReviewReuseCandidate {
  readonly version: typeof REVIEW_REUSE_CACHE_VERSION;
  readonly fingerprintVersion: typeof REVIEW_SEMANTIC_FINGERPRINT_VERSION;
  readonly namespace: string;
  readonly digest: string;
}

export interface ReviewReuseCacheStats {
  readonly restoredEntries: number;
  readonly invalidEntries: number;
}

export interface ReviewReuseCache {
  readonly stats: ReviewReuseCacheStats;
  match(path: string, fingerprint: string): ReviewReuseCandidate | undefined;
  write(
    path: string,
    fingerprint: string,
    base: string,
    head: string,
    record: FileReviewRecord,
    executionDurationMs: number,
    verifyCandidates: boolean,
  ): Promise<void>;
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function pathKey(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

function validRepositoryPath(path: string): boolean {
  const segments = path.split('/');
  return !path.startsWith('/')
    && !path.includes('\\')
    && !path.includes('\0')
    && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function normalizedSemanticValue(value: unknown, bundle: ReviewBundle): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizedSemanticValue(item, bundle));
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'fileId' || key === 'graphFactDigest') continue;
    const item = value[key];
    if ((key === 'revision' || key === 'snapshotRevision') && typeof item === 'string') {
      normalized[key] = item === bundle.manifest.head
        ? '$HEAD'
        : item === bundle.manifest.base
          ? '$BASE'
          : item;
      continue;
    }
    normalized[key] = normalizedSemanticValue(item, bundle);
  }
  if (isRecord(normalized['manifestEntry'])) {
    const { id: _id, ...entry } = normalized['manifestEntry'];
    normalized['manifestEntry'] = entry;
  }
  if (isRecord(normalized['revisions'])) {
    normalized['revisions'] = { base: '$BASE', head: '$HEAD' };
  }
  return normalized;
}

async function requirementsDigest(bundle: ReviewBundle): Promise<string | null> {
  if (bundle.requirementsPath === undefined) return null;
  return sha256(await readFile(bundle.requirementsPath));
}

/**
 * Hashes semantic review inputs while replacing exact base/head identities
 * with revision roles. This permits reuse across pushes only when the
 * authoritative diff, bounded source, policy, model configuration, and
 * resolved related context are otherwise identical.
 */
export async function buildReviewSemanticFingerprint(options: {
  readonly bundle: ReviewBundle;
  readonly file: ReviewManifestFile;
  readonly environment: ReviewEnvironment;
  readonly indexedContext: LoadedReviewCodeContext;
  readonly verifyCandidates: boolean;
  readonly followUpAvailable: boolean;
}): Promise<string> {
  const fileContext = codeContextForFile(options.indexedContext, options.file);
  const prompt = await buildFileReviewPrompt({
    bundle: options.bundle,
    file: options.file,
    findingScope: options.environment.findingScope,
    harness: options.environment.harness,
    model: options.environment.model.model,
    indexedContext: fileContext.prompt,
    followUpAvailable: options.followUpAvailable,
  });
  const context = JSON.parse(await buildFileContextPayload(
    options.bundle,
    options.file,
    fileContext.prompt,
  )) as unknown;
  const verificationPolicy = options.verifyCandidates
    ? await loadVerificationPolicy()
    : undefined;
  const semantic = {
    version: REVIEW_SEMANTIC_FINGERPRINT_VERSION,
    schema: {
      codeContext: CODE_CONTEXT_VERSION,
      document: FILE_REVIEW_DOCUMENT_VERSION,
      record: FILE_REVIEW_RECORD_VERSION,
      promptId: FILE_REVIEW_PROMPT_ID,
      promptVersion: FILE_REVIEW_PROMPT_VERSION,
      verificationDocument: options.verifyCandidates ? VERIFICATION_DOCUMENT_VERSION : null,
      verificationPromptId: options.verifyCandidates ? VERIFICATION_PROMPT_ID : null,
    },
    systemPrompt: prompt.system,
    policyDigest: prompt.policyDigest,
    verificationPolicyDigest: verificationPolicy?.digest ?? null,
    harness: options.environment.harness,
    model: {
      provider: options.environment.model.provider,
      endpoint: options.environment.model.endpoint,
      model: options.environment.model.model,
      auth: options.environment.model.auth ?? 'credential',
    },
    findingScope: options.environment.findingScope,
    timeoutMs: options.environment.timeout.milliseconds,
    verifyCandidates: options.verifyCandidates,
    followUpAvailable: options.followUpAvailable,
    requirementsDigest: await requirementsDigest(options.bundle),
    fileContext: normalizedSemanticValue(context, options.bundle),
    codeContextCoverage: normalizedSemanticValue(fileContext.coverage, options.bundle),
  };
  return sha256(canonicalJson(semantic));
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  assertOnlyKeys(value, allowed, label);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}`);
  }
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function optionalReason(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, MAX_REVIEW_REASON_CHARS, label);
}

function parseVerification(value: unknown): FileVerificationCoverage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('reuse verification must be an object');
  exactKeys(
    value,
    ['status', 'requested', 'accepted', 'rejected', 'durationMs', 'reason'],
    ['status', 'requested', 'accepted', 'rejected', 'durationMs'],
    'reuse verification',
  );
  if (!['not-applicable', 'completed', 'incomplete'].includes(String(value['status']))) {
    throw new Error('reuse verification status is unsupported');
  }
  const requested = nonNegativeInteger(value['requested'], MAX_FILE_FINDINGS, 'reuse verification requested');
  const accepted = nonNegativeInteger(value['accepted'], requested, 'reuse verification accepted');
  const rejected = nonNegativeInteger(value['rejected'], requested, 'reuse verification rejected');
  if (accepted + rejected > requested) throw new Error('reuse verification counts are inconsistent');
  return {
    status: value['status'] as FileVerificationCoverage['status'],
    requested,
    accepted,
    rejected,
    durationMs: nonNegativeInteger(value['durationMs'], MAX_REUSE_DURATION_MS, 'reuse verification duration'),
    ...(value['reason'] === undefined ? {} : { reason: optionalReason(value['reason'], 'reuse verification reason') }),
  };
}

function parseFollowUp(value: unknown): FileFollowUpCoverage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('reuse follow-up must be an object');
  exactKeys(
    value,
    ['status', 'requested', 'completed', 'omitted', 'durationMs', 'reason'],
    ['status', 'requested', 'completed', 'omitted', 'durationMs'],
    'reuse follow-up',
  );
  if (!['not-applicable', 'completed', 'incomplete'].includes(String(value['status']))) {
    throw new Error('reuse follow-up status is unsupported');
  }
  const requested = nonNegativeInteger(value['requested'], 64, 'reuse follow-up requested');
  const completed = nonNegativeInteger(value['completed'], requested, 'reuse follow-up completed');
  const omitted = nonNegativeInteger(value['omitted'], requested, 'reuse follow-up omitted');
  if (completed + omitted > requested) throw new Error('reuse follow-up counts are inconsistent');
  return {
    status: value['status'] as FileFollowUpCoverage['status'],
    requested,
    completed,
    omitted,
    durationMs: nonNegativeInteger(value['durationMs'], MAX_REUSE_DURATION_MS, 'reuse follow-up duration'),
    ...(value['reason'] === undefined ? {} : { reason: optionalReason(value['reason'], 'reuse follow-up reason') }),
  };
}

function parseRejectedCandidates(value: unknown): readonly RejectedCandidate[] {
  if (!Array.isArray(value) || value.length > MAX_REJECTED_CANDIDATES) {
    throw new Error('reuse rejected candidates must be a bounded array');
  }
  return value.map((item, position) => {
    if (!isRecord(item)) throw new Error(`reuse rejected candidate ${position} must be an object`);
    exactKeys(item, ['index', 'stage', 'code', 'reason'], ['index', 'stage', 'code', 'reason'], `reuse rejected candidate ${position}`);
    if (!['parse', 'validation', 'verification'].includes(String(item['stage']))) {
      throw new Error(`reuse rejected candidate ${position} stage is unsupported`);
    }
    return {
      index: nonNegativeInteger(item['index'], MAX_FILE_FINDINGS - 1, `reuse rejected candidate ${position} index`),
      stage: item['stage'] as RejectedCandidate['stage'],
      code: boundedString(item['code'], 128, `reuse rejected candidate ${position} code`),
      reason: boundedString(
        item['reason'],
        MAX_PERSISTED_REVIEW_REASON_CHARS,
        `reuse rejected candidate ${position} reason`,
      ),
    };
  });
}

function parseCachedResult(value: unknown): CachedReviewResult {
  if (!isRecord(value)) throw new Error('reuse result must be an object');
  exactKeys(
    value,
    ['outcome', 'reason', 'findings', 'rejectedCandidates', 'verification', 'followUp', 'executionDurationMs'],
    ['outcome', 'findings', 'rejectedCandidates', 'executionDurationMs'],
    'reuse result',
  );
  if (value['outcome'] !== 'clean' && value['outcome'] !== 'findings') {
    throw new Error('reuse result outcome is not reusable');
  }
  if (!Array.isArray(value['findings']) || value['findings'].length > MAX_FILE_FINDINGS) {
    throw new Error('reuse findings must be a bounded array');
  }
  if (value['outcome'] === 'clean' && value['findings'].length > 0) {
    throw new Error('clean reuse result contains findings');
  }
  if (value['outcome'] === 'findings' && value['findings'].length === 0) {
    throw new Error('findings reuse result contains no findings');
  }
  const findings = value['findings'].map((item, index): CachedReviewFinding => {
    if (!isRecord(item)) throw new Error(`reuse finding ${index} must be an object`);
    exactKeys(item, ['finding', 'suggestion'], ['finding', 'suggestion'], `reuse finding ${index}`);
    if (isRecord(item['finding']) && Object.hasOwn(item['finding'], 'suggestedChange')) {
      throw new Error(`reuse finding ${index} contains a discarded model suggestion`);
    }
    const suggestion = item['suggestion'] === null
      ? null
      : boundedString(item['suggestion'], MAX_CACHED_SUGGESTION_CHARS, `reuse finding ${index} suggestion`);
    return { finding: parseReusableReviewFinding(item['finding']), suggestion };
  });
  return {
    outcome: value['outcome'],
    ...(value['reason'] === undefined ? {} : { reason: optionalReason(value['reason'], 'reuse result reason') }),
    findings,
    rejectedCandidates: parseRejectedCandidates(value['rejectedCandidates']),
    ...(value['verification'] === undefined ? {} : { verification: parseVerification(value['verification']) }),
    ...(value['followUp'] === undefined ? {} : { followUp: parseFollowUp(value['followUp']) }),
    executionDurationMs: nonNegativeInteger(
      value['executionDurationMs'],
      MAX_REUSE_DURATION_MS,
      'reuse execution duration',
    ),
  };
}

function parseStoredEntry(value: unknown, namespace: string, fileName: string): StoredReviewReuseEntry {
  if (!isRecord(value)) throw new Error('reuse entry must be an object');
  exactKeys(
    value,
    ['version', 'fingerprintVersion', 'namespace', 'path', 'base', 'head', 'fingerprint', 'result', 'digest'],
    ['version', 'fingerprintVersion', 'namespace', 'path', 'base', 'head', 'fingerprint', 'result', 'digest'],
    'reuse entry',
  );
  if (value['version'] !== REVIEW_REUSE_CACHE_VERSION
    || value['fingerprintVersion'] !== REVIEW_SEMANTIC_FINGERPRINT_VERSION) {
    throw new Error('reuse entry version is unsupported');
  }
  if (value['namespace'] !== namespace) throw new Error('reuse entry namespace does not match');
  const path = boundedString(value['path'], 4_096, 'reuse entry path');
  if (!validRepositoryPath(path) || `${pathKey(path)}.json` !== fileName) {
    throw new Error('reuse entry path identity is invalid');
  }
  const base = boundedString(value['base'], 64, 'reuse entry base');
  const head = boundedString(value['head'], 64, 'reuse entry head');
  if (!COMMIT_PATTERN.test(base) || !COMMIT_PATTERN.test(head) || base === head) {
    throw new Error('reuse entry revisions are invalid');
  }
  const fingerprint = boundedString(value['fingerprint'], 71, 'reuse entry fingerprint');
  const digest = boundedString(value['digest'], 71, 'reuse entry digest');
  if (!SHA256_PATTERN.test(fingerprint) || !SHA256_PATTERN.test(digest)) {
    throw new Error('reuse entry digest is invalid');
  }
  const { digest: _digest, ...payload } = value;
  if (sha256(canonicalJson(payload)) !== digest) throw new Error('reuse entry digest does not match');
  return {
    version: REVIEW_REUSE_CACHE_VERSION,
    fingerprintVersion: REVIEW_SEMANTIC_FINGERPRINT_VERSION,
    namespace,
    path,
    base,
    head,
    fingerprint,
    result: parseCachedResult(value['result']),
    digest,
  };
}

function cacheResult(record: FileReviewRecord, executionDurationMs: number): CachedReviewResult {
  const findings = record.findings.map((finding): CachedReviewFinding => {
    const { id: _id, suggestion, fixPrompt: _fixPrompt, ...reviewFinding } = finding;
    return { finding: reviewFinding, suggestion: suggestion ?? null };
  });
  return {
    outcome: record.outcome as 'clean' | 'findings',
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    findings,
    rejectedCandidates: record.rejectedCandidates,
    ...(record.verification === undefined ? {} : { verification: record.verification }),
    ...(record.followUp === undefined ? {} : { followUp: record.followUp }),
    executionDurationMs,
  };
}

function reusableResult(result: CachedReviewResult, verifyCandidates: boolean): boolean {
  if (result.outcome !== 'clean' && result.outcome !== 'findings') return false;
  if (result.verification?.status === 'incomplete') return false;
  if (verifyCandidates) {
    if (result.verification === undefined || (result.followUp?.requested ?? 0) > 0) return false;
    if (result.outcome === 'findings') {
      return result.verification.status === 'completed'
        && result.findings.every((item) => item.finding.verification.status === 'confirmed');
    }
    return result.verification.status === 'not-applicable' || result.verification.status === 'completed';
  }
  return result.verification === undefined
    && result.findings.every((item) => item.finding.verification.status === 'unverified');
}

async function safeCacheDirectory(configuration: ReviewReuseEnvironment): Promise<string | undefined> {
  try {
    await mkdir(configuration.directory, { recursive: true });
    const rootInfo = await lstat(configuration.directory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined;
    const entries = join(configuration.directory, 'entries');
    await mkdir(entries, { recursive: true });
    const entriesInfo = await lstat(entries);
    return entriesInfo.isDirectory() && !entriesInfo.isSymbolicLink() ? entries : undefined;
  } catch {
    return undefined;
  }
}

/** Loads bounded restored records. Invalid entries are ignored and counted. */
export async function loadReviewReuseCache(configuration: ReviewReuseEnvironment): Promise<ReviewReuseCache> {
  const entriesDirectory = await safeCacheDirectory(configuration);
  const entries = new Map<string, StoredReviewReuseEntry>();
  let invalidEntries = entriesDirectory === undefined ? 1 : 0;
  if (entriesDirectory !== undefined) {
    const names: string[] = [];
    let totalBytes = 0;
    try {
      const directory = await opendir(entriesDirectory);
      for await (const entry of directory) {
        names.push(entry.name);
        if (names.length > MAX_REUSE_ENTRIES) break;
      }
      if (names.length > MAX_REUSE_ENTRIES) {
        invalidEntries += names.length;
      } else {
        for (const name of names.sort()) {
          if (!CACHE_FILE_PATTERN.test(name)) {
            invalidEntries += 1;
            continue;
          }
          const path = join(entriesDirectory, name);
          try {
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REUSE_ENTRY_BYTES) {
              throw new Error('reuse cache entry is not a bounded regular file');
            }
            totalBytes += info.size;
            if (totalBytes > MAX_REUSE_TOTAL_BYTES) throw new Error('reuse cache exceeds its total byte limit');
            const parsed = parseStoredEntry(
              JSON.parse(await readFile(path, 'utf8')) as unknown,
              configuration.namespace,
              name,
            );
            entries.set(parsed.path, parsed);
          } catch {
            invalidEntries += 1;
          }
        }
      }
    } catch {
      invalidEntries += 1;
      entries.clear();
    }
  }

  return {
    stats: { restoredEntries: entries.size, invalidEntries },
    match(path: string, fingerprint: string): ReviewReuseCandidate | undefined {
      const entry = entries.get(path);
      return entry?.fingerprint === fingerprint ? entry : undefined;
    },
    async write(path, fingerprint, base, head, record, executionDurationMs, verifyCandidates): Promise<void> {
      if (entriesDirectory === undefined || (record.outcome !== 'clean' && record.outcome !== 'findings')) return;
      const result = cacheResult(record, executionDurationMs);
      if (!reusableResult(result, verifyCandidates)) return;
      const payload = {
        version: REVIEW_REUSE_CACHE_VERSION,
        fingerprintVersion: REVIEW_SEMANTIC_FINGERPRINT_VERSION,
        namespace: configuration.namespace,
        path,
        base,
        head,
        fingerprint,
        result,
      };
      const stored: StoredReviewReuseEntry = { ...payload, digest: sha256(canonicalJson(payload)) };
      const content = `${JSON.stringify(stored, null, 2)}\n`;
      if (Buffer.byteLength(content, 'utf8') > MAX_REUSE_ENTRY_BYTES) return;
      const target = join(entriesDirectory, `${pathKey(path)}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
        entries.set(path, stored);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

function remapFindingRevisions(
  finding: ReviewFinding,
  candidate: ReviewReuseCandidate,
  bundle: ReviewBundle,
): ReviewFinding {
  const supportingEvidence = finding.supportingEvidence.map((evidence) => {
    const revision = evidence.revision === candidate.head
      ? bundle.manifest.head
      : evidence.revision === candidate.base
        ? bundle.manifest.base
        : undefined;
    if (revision === undefined) throw new Error('cached supporting evidence revision is not from its source run');
    return { ...evidence, revision };
  });
  const graphReferences = finding.graphReferences.map((reference) => {
    if (reference.snapshotRevision !== candidate.base) {
      throw new Error('cached graph reference is not from its source base snapshot');
    }
    const remapped = { ...reference, snapshotRevision: bundle.manifest.base };
    return { ...remapped, graphFactDigest: codeContextGraphFactDigest(remapped) };
  });
  return { ...finding, supportingEvidence, graphReferences };
}

async function revalidateCachedSuggestion(
  suggestion: string | null,
  bundle: ReviewBundle,
  file: ReviewManifestFile,
  finding: ValidatedFinding,
  changed: ChangedLines,
): Promise<string | undefined> {
  if (suggestion === null) return undefined;
  const spanLines = await resolveSpanLines(
    bundle,
    file,
    finding.side,
    finding.startLine,
    finding.endLine,
    changed,
  );
  if (spanLines === undefined) throw new Error('cached suggestion span is not resolvable');
  const lines = suggestion.split('\n');
  const currentLines = spanLines.map((line) => `-${line}`);
  if (lines.length <= currentLines.length
    || currentLines.some((line, index) => lines[index] !== line)) {
    throw new Error('cached suggestion does not match the authoritative span');
  }
  const proposedLines = lines.slice(currentLines.length);
  if (proposedLines.some((line) => !line.startsWith('+'))) {
    throw new Error('cached suggestion replacement is malformed');
  }
  return renderSuggestion(spanLines, proposedLines.map((line) => line.slice(1)));
}

/** Revalidates a fingerprint-matched cached result against current authoritative evidence. */
export async function restoreReusableFileReview(options: {
  readonly candidate: ReviewReuseCandidate;
  readonly bundle: ReviewBundle;
  readonly file: ReviewManifestFile;
  readonly environment: ReviewEnvironment;
  readonly indexedContext: LoadedReviewCodeContext;
  readonly verifyCandidates: boolean;
}): Promise<FileReviewRecord> {
  const { candidate, bundle, file, environment, indexedContext } = options;
  if (!reusableResult(candidate.result, options.verifyCandidates)) {
    throw new Error('cached result is not eligible for the current verification mode');
  }
  const path = file.newPath ?? file.oldPath ?? file.id;
  if (candidate.path !== path) throw new Error('cached result path does not match the current file');
  const diff = await readFile(join(bundle.root, file.diffFile), 'utf8');
  const validator = new FileReviewValidator(file, diff, environment.findingScope);
  const published: PublishedFinding[] = [];
  for (const cachedFinding of candidate.result.findings) {
    const remapped = remapFindingRevisions(cachedFinding.finding, candidate, bundle);
    const validated = validator.validateFinding(remapped);
    await validateFindingReferences(bundle, validated, indexedContext);
    const remediation = await buildRemediation(bundle, file, validated, validator.changed);
    const cachedSuggestion = await revalidateCachedSuggestion(
      cachedFinding.suggestion,
      bundle,
      file,
      validated,
      validator.changed,
    );
    const { suggestedChange: _discarded, ...core } = validated;
    const suggestion = remediation.suggestion ?? cachedSuggestion;
    published.push({
      ...core,
      ...(suggestion === undefined ? {} : { suggestion }),
      fixPrompt: remediation.fixPrompt,
    });
  }
  if ((candidate.result.outcome === 'clean') !== (published.length === 0)) {
    throw new Error('cached result outcome is inconsistent after current validation');
  }
  const fileContext: FileReviewCodeContext = codeContextForFile(indexedContext, file);
  return {
    version: FILE_REVIEW_RECORD_VERSION,
    fileId: file.id,
    path,
    status: file.status,
    harness: environment.harness,
    model: environment.model.model,
    codeContext: fileContext.coverage,
    ...(candidate.result.verification === undefined ? {} : { verification: candidate.result.verification }),
    ...(candidate.result.followUp === undefined ? {} : { followUp: candidate.result.followUp }),
    outcome: candidate.result.outcome,
    ...(candidate.result.reason === undefined ? {} : { reason: candidate.result.reason }),
    findings: published,
    rejectedCandidates: candidate.result.rejectedCandidates,
    durationMs: 0,
    execution: 'reused',
    savedDurationMs: candidate.result.executionDurationMs,
  };
}
