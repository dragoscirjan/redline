import {
  parseFollowUpResults,
  type FollowUpReason,
  type FollowUpRequestBatch,
  type FollowUpResult,
  type FollowUpStatus,
} from '../code-context/follow-up.ts';
import type { CodeContextProvider } from '../code-context/artifact.ts';
import type { ReviewBundle } from './bundle.ts';
import { SourceMismatchError, validateSourceEvidence } from './source-evidence.ts';
import type { SourceEvidence } from './types.ts';

export interface ResolvedFollowUp {
  readonly requestId: string;
  readonly candidateId: string;
  readonly status: FollowUpStatus;
  readonly reason: FollowUpReason | null;
  readonly durationMs: number;
  readonly sources: readonly SourceEvidence[];
  /** Provider relationship labels stay provenance, never citation authority. */
  readonly relationships: readonly string[];
}

export function classifyFollowUpSourceFailure(error: unknown): FollowUpReason {
  return error instanceof SourceMismatchError ? 'source-disagreement' : 'source-unavailable';
}

function degraded(result: FollowUpResult, candidateId: string, reason: FollowUpReason): ResolvedFollowUp {
  return {
    requestId: result.requestId,
    candidateId,
    status: 'partial',
    reason,
    durationMs: result.durationMs,
    sources: [],
    relationships: [],
  };
}

/** Action relationships select candidates; every supplied source anchor is checked against captured head bytes. */
export async function resolveFollowUpResults(
  bundle: ReviewBundle,
  requests: FollowUpRequestBatch,
  raw: string,
  expectedProvider: CodeContextProvider | null,
): Promise<readonly ResolvedFollowUp[]> {
  if (requests.base !== bundle.manifest.base || requests.head !== bundle.manifest.head) {
    throw new Error('follow-up request does not match the loaded source snapshot');
  }
  const parsed = parseFollowUpResults(raw, requests, expectedProvider);
  const requestById = new Map(requests.requests.map((item) => [item.id, item]));
  const output: ResolvedFollowUp[] = [];
  for (const item of parsed.results) {
    const request = requestById.get(item.requestId);
    if (request === undefined) throw new Error('follow-up request identity is not in the validated plan');
    if (item.status !== 'complete') {
      output.push({
        requestId: request.id, candidateId: request.candidateId,
        status: item.status, reason: item.reason, durationMs: item.durationMs, sources: [], relationships: [],
      });
      continue;
    }
    const sources: SourceEvidence[] = [];
    let limitation: FollowUpReason | null = null;
    for (const span of item.spans) {
      const source: SourceEvidence = {
        role: 'impact-path',
        revision: bundle.manifest.head,
        path: span.path,
        startLine: span.startLine,
        endLine: span.endLine,
        evidence: span.evidence,
      };
      try {
        await validateSourceEvidence(bundle, source);
        sources.push(source);
      } catch (error) {
        limitation = classifyFollowUpSourceFailure(error);
        break;
      }
    }
    output.push(limitation === null ? {
      requestId: request.id, candidateId: request.candidateId,
      status: 'complete', reason: null, durationMs: item.durationMs, sources,
      relationships: item.spans.map((span) => span.relationship),
    } : degraded(item, request.candidateId, limitation));
  }
  return output;
}

/** Source evidence is candidate-scoped; a graph edge by itself cannot authorize publication. */
export function followUpSourcesByCandidate(results: readonly ResolvedFollowUp[]): ReadonlyMap<string, readonly SourceEvidence[]> {
  const gathered = new Map<string, SourceEvidence[]>();
  for (const item of results) {
    if (item.status !== 'complete') continue;
    const sources = gathered.get(item.candidateId) ?? [];
    sources.push(...item.sources);
    gathered.set(item.candidateId, sources);
  }
  return gathered;
}
