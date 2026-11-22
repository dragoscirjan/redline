import type { PullRequestFinding, ReviewSynthesis } from './types.ts';

export function synthesizeReview(findings: readonly PullRequestFinding[], budgets: ReviewSynthesis['budgets']): ReviewSynthesis {
  // Group source-backed duplicates/conflicts and apply explicit publication budgets without rerunning models.
  throw new Error('Not implemented: synthesizeReview');
}
