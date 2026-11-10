/** Local caller-managed retry policy. Legacy Action invocations leave it unset. */
import type { FileReviewRecord } from './types.ts';

export const DEFAULT_REVIEW_RETRIES = 3;
export const MAX_REVIEW_RETRIES = 10;
export const RETRY_TIMEOUT_INCREMENT_MS = 120_000;
export type ReviewRetryReason = 'upstream-failure' | 'invalid-output' | 'file-timeout' | 'source-excerpt';

export function parseReviewRetries(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_REVIEW_RETRIES) {
    throw new Error(`retries must be an integer from 0 to ${MAX_REVIEW_RETRIES}`);
  }
  return Number(value);
}

export function reviewRetryReason(record: Pick<FileReviewRecord, 'outcome' | 'execution' | 'errorKind' | 'reason'>, upstreamRetryable: boolean): ReviewRetryReason | undefined {
  if (record.outcome !== 'omitted' || record.execution === 'not-started' || record.execution === 'reused') return undefined;
  if (record.errorKind === 'harness-timeout') return 'file-timeout';
  if (record.errorKind === 'invalid-output') return 'invalid-output';
  if (record.errorKind === 'harness-failed' && upstreamRetryable) return 'upstream-failure';
  // Model prose selects no paths or limits. It can only request a bounded retry
  // of this same file, whose source is resolved from the immutable capture.
  if (record.errorKind === undefined && /\b(?:source|excerpt|context|truncat\w*|coverage|entire|whole file|full file|incomplete)\b/iu.test(record.reason ?? '')) {
    return 'source-excerpt';
  }
  return undefined;
}

/** Retry-round index is trusted and bounded by MAX_REVIEW_RETRIES. */
export function upstreamRetryDelayMs(round: number): number {
  return Math.min(5_000, 1_000 * 2 ** (round - 1));
}

export function maximumFileAttemptTimeMs(timeoutMs: number, retries: number): number {
  return (retries + 1) * timeoutMs + RETRY_TIMEOUT_INCREMENT_MS * retries * (retries + 1) / 2;
}
