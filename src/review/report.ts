import type { FollowUpDirection } from '../code-context/provider.ts';
import type { AuthoritativeReviewContext, RejectedCandidate, ReviewFinding, ValidatedFinding } from './types.ts';

/** Existing document versions are retained; this prototype does not implement their parser. */
export const FILE_REVIEW_DOCUMENT_VERSION = 4 as const;
export const PREVIOUS_FILE_REVIEW_DOCUMENT_VERSION = 3 as const;
export const LEGACY_FILE_REVIEW_DOCUMENT_VERSION = 2 as const;
export interface FileReviewDocument {
  readonly version: typeof FILE_REVIEW_DOCUMENT_VERSION | typeof PREVIOUS_FILE_REVIEW_DOCUMENT_VERSION | typeof LEGACY_FILE_REVIEW_DOCUMENT_VERSION;
  readonly fileId: string;
  readonly outcome: 'clean' | 'findings' | 'omitted';
  readonly reason: string | undefined;
  readonly findings: readonly ReviewFinding[];
  readonly candidateIndices: readonly number[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
  readonly contextRequests: readonly { readonly candidateIndex: number; readonly direction: FollowUpDirection }[];
}
export interface CandidateValidationResult {
  readonly findings: readonly ValidatedFinding[];
  readonly candidateIndices: readonly number[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
}

export function parseFileReviewDocument(raw: string): FileReviewDocument {
  // Parse the authoritative versioned finding schema; structured generation never replaces local validation.
  throw new Error('Not implemented: parseFileReviewDocument');
}

export class FileReviewValidator {
  validateFinding(finding: ReviewFinding, context: AuthoritativeReviewContext): ValidatedFinding {
    // Resolve both endpoints to changed lines and verify byte-identical evidence against bounded authoritative source.
    throw new Error('Not implemented: FileReviewValidator.validateFinding');
  }

  validateCandidates(document: FileReviewDocument, context: AuthoritativeReviewContext): CandidateValidationResult {
    // Isolate invalid candidates, preserving original indexes, rejection reasons and explicit coverage.
    throw new Error('Not implemented: FileReviewValidator.validateCandidates');
  }
}
