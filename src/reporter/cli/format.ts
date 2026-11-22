import type { ReviewReport } from '../../review/types.ts';

export function formatCliReview(report: ReviewReport): string {
  // Project validated findings, coverage and diagnostics for terminal output with sanitization; do not parse flags or write JSON.
  throw new Error('Not implemented: formatCliReview');
}
