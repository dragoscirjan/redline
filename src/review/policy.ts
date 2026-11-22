import type { FileReviewInput } from './types.ts';

export type TrustedReviewFocus = unknown;
export type ReviewPrompt = unknown;

export function buildReviewPrompt(input: FileReviewInput, focus: TrustedReviewFocus): ReviewPrompt {
  // Compose fixed versioned review policy and optional trusted focus; contributor text cannot change tools, budgets or schemas.
  // Keep broad domains and spanless PR-level checks distinct from diff-anchored findings.
  throw new Error('Not implemented: buildReviewPrompt');
}
