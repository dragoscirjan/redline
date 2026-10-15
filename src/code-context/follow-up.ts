/** Provider-neutral follow-up exchange. Only trusted action code may execute requests. */
import { createHash } from 'node:crypto';
import type { CodeContextProvider } from './artifact.js';

export const FOLLOW_UP_VERSION = 1 as const;
export const FOLLOW_UP_LIMITS = Object.freeze({
  requestsPerRun: 8,
  requestsPerFile: 2,
  resultsPerRequest: 8,
  spanLines: 80,
  sourceBytesPerRun: 48 * 1024,
  requestBytesPerRun: 16 * 1024,
  resultBytesPerRun: 256 * 1024,
  millisecondsPerRequest: 20_000,
  millisecondsPerRun: 120_000,
  depth: 1,
  fanOut: 8,
});

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const FILE_ID = /^\d{6}$/u;
const FINDING_ID = /^f-[0-9a-f]{24}$/u;
const DIGEST = /^related-span:sha256:[0-9a-f]{64}$/u;

export type FollowUpDirection = 'incoming' | 'outgoing';
export type FollowUpStatus = 'complete' | 'partial' | 'unsupported' | 'unavailable';
export type FollowUpReason =
  | 'not-configured' | 'capability-unsupported' | 'snapshot-stale' | 'language-unsupported'
  | 'query-failed' | 'query-timed-out' | 'result-truncated' | 'path-ambiguous' | 'source-unavailable'
  | 'source-disagreement';

export interface FollowUpIdentity {
  readonly repository: string;
  readonly base: string;
  readonly head: string;
}

/** Intent contains no provider query text, path, snapshot, or executable input. */
export interface FollowUpIntent {
  readonly candidateId: string;
  readonly direction: FollowUpDirection;
}

export interface FollowUpRequest {
  readonly id: string;
  readonly fileId: string;
  readonly candidateId: string;
  readonly changedPath: string;
  readonly capability: 'related-spans';
  readonly direction: FollowUpDirection;
  readonly depth: 1;
  readonly fanOut: 8;
  readonly resultLimit: 8;
}

export interface FollowUpRequestBatch extends FollowUpIdentity {
  readonly version: typeof FOLLOW_UP_VERSION;
  readonly requests: readonly FollowUpRequest[];
  readonly omitted: number;
}

export interface FollowUpSpan {
  readonly path: string;
  readonly revision: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Anchor-line text only, not a proof of the relationship. */
  readonly evidence: string;
  readonly relationship: 'changed-code-calls-related-symbol' | 'related-symbol-calls-changed-code';
}

export interface FollowUpResult {
  readonly requestId: string;
  readonly status: FollowUpStatus;
  readonly reason: FollowUpReason | null;
  readonly durationMs: number;
  readonly spans: readonly FollowUpSpan[];
}

export interface FollowUpResultBatch extends FollowUpIdentity {
  readonly version: typeof FOLLOW_UP_VERSION;
  readonly provider: CodeContextProvider | null;
  readonly snapshot: string | null;
  readonly results: readonly FollowUpResult[];
}

function exactObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`${label} has unexpected fields`);
  return result;
}

function sourcePath(path: unknown, label: string): string {
  if (typeof path !== 'string' || path.length === 0 || Buffer.byteLength(path, 'utf8') > 4_096
    || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f]/u.test(path)
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} is not a normalized source path`);
  }
  return path;
}

function identity(value: FollowUpIdentity): void {
  if (!REPOSITORY.test(value.repository) || !SHA.test(value.base) || !SHA.test(value.head)
    || value.base === value.head) throw new Error('follow-up snapshot identity is invalid');
}

function requestId(identityValue: FollowUpIdentity, fileId: string, candidateId: string, path: string, direction: FollowUpDirection): string {
  const digest = createHash('sha256').update(JSON.stringify([
    identityValue.repository, identityValue.base, identityValue.head, fileId, candidateId, path, direction,
  ])).digest('hex');
  return `related-span:sha256:${digest}`;
}

/** Caller supplies only validated candidate IDs and the manifest path; model text cannot become Cypher. */
export class FollowUpBudget {
  #used = 0;
  #perFile = new Map<string, number>();
  #sourceBytes = 0;
  #requestBytes = 0;
  #resultBytes = 0;
  #durationMs = 0;

  remainingTimeMs(): number {
    return Math.max(0, FOLLOW_UP_LIMITS.millisecondsPerRun - this.#durationMs);
  }

  /** Failed or malformed provider calls still spend their wall-clock time. */
  spendFailure(wallClockMs: number): void {
    if (!Number.isSafeInteger(wallClockMs) || wallClockMs < 0) throw new Error('follow-up wall-clock duration is invalid');
    this.#durationMs = Math.min(FOLLOW_UP_LIMITS.millisecondsPerRun, this.#durationMs + wallClockMs);
  }

  /** Consume only revalidated result evidence under cumulative run budgets. */
  consume(raw: string, results: readonly { readonly durationMs: number;
    readonly sources: readonly { readonly evidence: string }[] }[], wallClockMs = 0): void {
    const resultBytes = Buffer.byteLength(raw, 'utf8');
    const sourceBytes = results.reduce((sum, item) => sum + item.sources.reduce((bytes, source) =>
      bytes + Buffer.byteLength(source.evidence, 'utf8'), 0), 0);
    if (!Number.isSafeInteger(wallClockMs) || wallClockMs < 0) throw new Error('follow-up wall-clock duration is invalid');
    const durationMs = Math.max(wallClockMs, results.reduce((sum, item) => sum + item.durationMs, 0));
    if (this.#resultBytes + resultBytes > FOLLOW_UP_LIMITS.resultBytesPerRun
      || this.#sourceBytes + sourceBytes > FOLLOW_UP_LIMITS.sourceBytesPerRun
      || this.#durationMs + durationMs > FOLLOW_UP_LIMITS.millisecondsPerRun) {
      throw new Error('cumulative follow-up result, source, or duration budget exceeded');
    }
    this.#resultBytes += resultBytes;
    this.#sourceBytes += sourceBytes;
    this.#durationMs += durationMs;
  }

  plan(
    identityValue: FollowUpIdentity,
    fileId: string,
    changedPath: string,
    candidates: readonly string[],
    intents: readonly FollowUpIntent[],
  ): FollowUpRequestBatch {
    identity(identityValue);
    if (!FILE_ID.test(fileId)) throw new Error('follow-up file identity is invalid');
    sourcePath(changedPath, 'follow-up changed path');
    if (new Set(candidates).size !== candidates.length || candidates.some((id) => !FINDING_ID.test(id))) {
      throw new Error('follow-up candidate identities are invalid');
    }
    if (intents.length > 20) throw new Error('follow-up intents exceed their input limit');
    if (this.remainingTimeMs() === 0) throw new Error('cumulative follow-up time budget exhausted');
    const known = new Set(candidates);
    const seen = new Set<string>();
    const requests: FollowUpRequest[] = [];
    let omitted = 0;
    for (const intent of intents) {
      if (!known.has(intent.candidateId) || !['incoming', 'outgoing'].includes(intent.direction)) {
        throw new Error('follow-up intent does not identify a validated candidate and direction');
      }
      const id = requestId(identityValue, fileId, intent.candidateId, changedPath, intent.direction);
      if (seen.has(id)) continue;
      seen.add(id);
      if (this.#used >= FOLLOW_UP_LIMITS.requestsPerRun
        || (this.#perFile.get(fileId) ?? 0) >= FOLLOW_UP_LIMITS.requestsPerFile) {
        omitted += 1;
        continue;
      }
      requests.push({ id, fileId, candidateId: intent.candidateId, changedPath,
        capability: 'related-spans', direction: intent.direction, depth: 1, fanOut: 8, resultLimit: 8 });
      this.#used += 1;
      this.#perFile.set(fileId, (this.#perFile.get(fileId) ?? 0) + 1);
    }
    const batch: FollowUpRequestBatch = { version: FOLLOW_UP_VERSION, ...identityValue, requests, omitted };
    const bytes = Buffer.byteLength(JSON.stringify(batch), 'utf8');
    if (this.#requestBytes + bytes > FOLLOW_UP_LIMITS.requestBytesPerRun) {
      throw new Error('cumulative follow-up request byte budget exceeded');
    }
    this.#requestBytes += bytes;
    return batch;
  }
}

/** Check an action-produced result against the exact requests; source spans still require re-resolution. */
export function parseFollowUpResults(
  raw: string,
  expected: FollowUpRequestBatch,
  expectedProvider: CodeContextProvider | null,
): FollowUpResultBatch {
  if (Buffer.byteLength(raw, 'utf8') > FOLLOW_UP_LIMITS.resultBytesPerRun) {
    throw new Error('follow-up results exceed the run byte budget');
  }
  const data = exactObject(JSON.parse(raw) as unknown, 'follow-up results', [
    'version', 'repository', 'base', 'head', 'provider', 'snapshot', 'results',
  ]);
  if (data['version'] !== FOLLOW_UP_VERSION || data['repository'] !== expected.repository
    || data['base'] !== expected.base || data['head'] !== expected.head) {
    throw new Error('follow-up results do not match the exact review identity');
  }
  const provider = data['provider'];
  if (expectedProvider === null) {
    if (provider !== null || data['snapshot'] !== null) throw new Error('follow-up results claim an unavailable provider');
  } else {
    const selected = exactObject(provider, 'follow-up provider', ['id', 'version']);
    if (selected['id'] !== expectedProvider.id || selected['version'] !== expectedProvider.version
      || data['snapshot'] !== expected.base) {
      throw new Error('follow-up provider version or base snapshot does not match');
    }
  }
  const entries = data['results'];
  if (!Array.isArray(entries) || entries.length !== expected.requests.length) {
    throw new Error('follow-up results do not cover every request');
  }
  if (expected.requests.length > FOLLOW_UP_LIMITS.requestsPerRun
    || expected.requests.some((request) => !DIGEST.test(request.id))) {
    throw new Error('follow-up request batch exceeds its fixed identity or count limit');
  }
  const requests = new Map(expected.requests.map((request) => [request.id, request]));
  if (requests.size !== expected.requests.length) throw new Error('follow-up request IDs must be unique');
  const seen = new Set<string>();
  let runMilliseconds = 0;
  let sourceBytes = 0;
  const results = entries.map((value: unknown): FollowUpResult => {
    const item = exactObject(value, 'follow-up result', ['requestId', 'status', 'reason', 'durationMs', 'spans']);
    const request = requests.get(item['requestId'] as string);
    if (request === undefined || seen.has(request.id)) throw new Error('follow-up result identity is missing or duplicated');
    seen.add(request.id);
    const status = item['status'];
    if (!['complete', 'partial', 'unsupported', 'unavailable'].includes(status as string)) {
      throw new Error('follow-up result status is unsupported');
    }
    if (expectedProvider === null && status !== 'unavailable') {
      throw new Error('follow-up result claims a complete query without a provider');
    }
    const reason = item['reason'];
    const reasons: readonly FollowUpReason[] = [
      'not-configured', 'capability-unsupported', 'snapshot-stale', 'language-unsupported',
      'query-failed', 'query-timed-out', 'result-truncated', 'path-ambiguous', 'source-unavailable',
      'source-disagreement',
    ];
    if ((status === 'complete' && reason !== null)
      || (status !== 'complete' && !reasons.includes(reason as FollowUpReason))) {
      throw new Error('follow-up result needs a bounded coverage reason');
    }
    const durationMs = item['durationMs'];
    if (!Number.isSafeInteger(durationMs) || (durationMs as number) < 0
      || (durationMs as number) > FOLLOW_UP_LIMITS.millisecondsPerRequest) {
      throw new Error('follow-up request exceeded its time limit');
    }
    runMilliseconds += durationMs as number;
    if (runMilliseconds > FOLLOW_UP_LIMITS.millisecondsPerRun) throw new Error('follow-up run exceeded its time budget');
    const rawSpans = item['spans'];
    if (!Array.isArray(rawSpans) || rawSpans.length > FOLLOW_UP_LIMITS.resultsPerRequest
      || (status !== 'complete' && rawSpans.length > 0)) {
      throw new Error('follow-up spans exceed the result limit or claim incomplete coverage');
    }
    const spans = rawSpans.map((span: unknown): FollowUpSpan => {
      const source = exactObject(span, 'follow-up span', [
        'path', 'revision', 'startLine', 'endLine', 'evidence', 'relationship',
      ]);
      const startLine = source['startLine'];
      const endLine = source['endLine'];
      if (source['revision'] !== expected.head || !Number.isSafeInteger(startLine) || (startLine as number) < 1
        || !Number.isSafeInteger(endLine) || (endLine as number) < (startLine as number)
        || (endLine as number) - (startLine as number) >= FOLLOW_UP_LIMITS.spanLines) {
        throw new Error('follow-up span is not at the exact head or exceeds its line budget');
      }
      const relationship = source['relationship'];
      const expectedRelationship = request.direction === 'incoming'
        ? 'related-symbol-calls-changed-code' : 'changed-code-calls-related-symbol';
      if (relationship !== expectedRelationship) throw new Error('follow-up relationship conflicts with the request');
      const evidence = source['evidence'];
      if (typeof evidence !== 'string' || evidence.length === 0 || evidence.includes('\0')) {
        throw new Error('follow-up span anchor text is invalid');
      }
      sourceBytes += Buffer.byteLength(evidence, 'utf8');
      if (sourceBytes > FOLLOW_UP_LIMITS.sourceBytesPerRun) throw new Error('follow-up source byte budget exceeded');
      return {
        path: sourcePath(source['path'], 'follow-up span path'),
        revision: expected.head,
        startLine: startLine as number,
        endLine: endLine as number,
        evidence,
        relationship: expectedRelationship,
      };
    });
    return {
      requestId: request.id, status: status as FollowUpStatus,
      reason: reason as FollowUpReason | null,
      durationMs: durationMs as number,
      spans,
    };
  });
  return {
    version: FOLLOW_UP_VERSION,
    repository: expected.repository,
    base: expected.base,
    head: expected.head,
    provider: expectedProvider,
    snapshot: expectedProvider === null ? null : expected.base,
    results,
  };
}
