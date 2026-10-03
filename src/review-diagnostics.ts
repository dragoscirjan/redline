import { byteLength } from './review-bundle.js';

/**
 * Bounded, structured failure context for a review run. Every field is
 * optional because different failure paths know different things; the
 * journal records whatever is known, and the summary comment renders the
 * human-readable subset. All fields are capped so a runaway backend cannot
 * balloon the journal or the comment.
 */

export const DIAGNOSTIC_FIELD_LIMIT = 64 * 1024;

export interface BackendDiagnosticEvent {
  /** Combined backend stderr (last-writer-wins truncation). */
  readonly stderr?: string;
  /** Backend process exit code, when the process exited. */
  readonly exitCode?: number | null;
  /** Backend process termination signal, when signaled. */
  readonly exitSignal?: string | null;
  /** The first harness-protocol parse failure, if any. */
  readonly firstProtocolError?: string;
  /** The first rejected harness event payload, bounded. */
  readonly firstRejectedEvent?: string;
  /** Total rejected events. */
  readonly rejectedEvents?: number;
  /** Total accepted events. */
  readonly acceptedEvents?: number;
  /** Narration (non-JSON) lines dropped by the stream parser. */
  readonly proseLines?: number;
  /** Truncated tail of the raw backend stdout that never parsed. */
  readonly unparsedStdoutTail?: string;
  /** The stage that failed, for example launch, stream, publication. */
  readonly failureStage?: string;
  /** Short human-readable failure reason. */
  readonly failureReason?: string;
}

export function boundedDiagnosticText(raw: string, label: string): string {
  if (raw.length === 0) return '';
  if (byteLength(raw) > DIAGNOSTIC_FIELD_LIMIT) {
    const cut = raw.slice(raw.length - DIAGNOSTIC_FIELD_LIMIT);
    return `[...truncated, showing last ${DIAGNOSTIC_FIELD_LIMIT} bytes of ${label}]\n${cut}`;
  }
  return raw;
}
