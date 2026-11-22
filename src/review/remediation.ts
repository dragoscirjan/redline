import type { AuthoritativeReviewContext, ValidatedFinding } from './types.ts';

/** Existing remediation projection; no model output is promoted to a verified fix. */
export interface Remediation {
  readonly suggestion?: string | undefined;
  readonly fixPrompt: string;
}

export function renderSuggestion(spanLines: readonly string[], proposedLines: readonly string[]): string {
  // Render a proposed replacement only from an authoritative span, never guessed or neighboring content.
  throw new Error('Not implemented: renderSuggestion');
}

export async function buildRemediation(finding: ValidatedFinding, context: AuthoritativeReviewContext): Promise<Remediation> {
  // Resolve diff/head/base evidence and derive the deterministic suggestion and always-present fix prompt.
  throw new Error('Not implemented: buildRemediation');
}
