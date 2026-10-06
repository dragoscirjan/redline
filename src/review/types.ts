/**
 * Review domain types shared by the prompt builder, validator, runner, and
 * output writer. These types are independent of harnesses, forges, and the
 * GitHub Action surface.
 */

export type FindingScope = 'defects' | 'defects-and-risks';

export const FINDING_SCOPES: readonly FindingScope[] = ['defects', 'defects-and-risks'];

export type FindingCategory = 'correctness' | 'security' | 'regression' | 'testing' | 'operational' | 'maintainability';

export type FindingClassification = 'defect' | 'risk';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export type FindingSide = 'LEFT' | 'RIGHT';

export interface ReviewFinding {
  readonly category: FindingCategory;
  readonly classification: FindingClassification;
  readonly severity: FindingSeverity;
  readonly confidence: number;
  readonly side: FindingSide;
  /**
   * The span of the issue: first and last line of the affected region on
   * `side`. Both endpoints must be changed lines of that side; the span may
   * include unchanged lines between them.
   */
  readonly startLine: number;
  readonly endLine: number;
  /** Exact content of `startLine` on that side, without its diff marker. */
  readonly evidence: string;
  readonly impact: string;
  readonly fix: string;
  /**
   * Model-proposed replacement text for the span's lines, as it should read
   * after the fix. Optional: omitted when no concrete replacement can be
   * proposed. Never published directly; the rendered `suggestion` and the
   * fix prompt are derived from it.
   */
  readonly suggestedChange?: string | undefined;
}

export interface ValidatedFinding extends ReviewFinding {
  readonly id: string;
}

/**
 * A validated finding enriched for publication: the rendered change
 * suggestion (when the span content is resolvable and the model proposed a
 * replacement) and the deterministic fix prompt for a coding agent.
 */
export interface PublishedFinding extends Omit<ValidatedFinding, 'suggestedChange'> {
  /**
   * Unified-diff-style suggestion lines (`-` current span lines, `+`
   * proposed replacement) usable by a human or a coding agent. Present only
   * when both the span content and a proposed change are available.
   */
  readonly suggestion?: string | undefined;
  /** Ready-to-use prompt for a coding LLM that applies the fix. */
  readonly fixPrompt: string;
}

export type FileReviewOutcome = 'clean' | 'findings' | 'omitted';

export type FileReviewErrorKind =
  | 'harness-failed'
  | 'harness-timeout'
  | 'invalid-output'
  | 'preparation-failed';

export const FILE_REVIEW_RECORD_VERSION = 2 as const;

/**
 * The persisted per-file review record. Written as JSON and Markdown into
 * the output directory; the JSON form is the machine-readable contract for
 * later comment publication.
 */
export interface FileReviewRecord {
  readonly version: typeof FILE_REVIEW_RECORD_VERSION;
  readonly fileId: string;
  readonly path: string;
  readonly status: string;
  readonly harness: string;
  readonly model: string;
  readonly outcome: FileReviewOutcome;
  readonly errorKind?: FileReviewErrorKind | undefined;
  readonly reason?: string | undefined;
  readonly findings: readonly PublishedFinding[];
  readonly durationMs: number;
}

export const REVIEW_RUN_SUMMARY_VERSION = 2 as const;

export interface ReviewRunSummaryFile {
  readonly fileId: string;
  readonly path: string;
  readonly outcome: FileReviewOutcome;
  readonly errorKind?: FileReviewErrorKind | undefined;
  readonly findingCount: number;
  /** Finding spans as `x` or `x-y` strings, one per published finding. */
  readonly findingSpans: readonly string[];
}

export interface ReviewRunSummary {
  readonly version: typeof REVIEW_RUN_SUMMARY_VERSION;
  readonly harness: string;
  readonly model: string;
  readonly provider: string;
  readonly findingScope: FindingScope;
  readonly base: string;
  readonly head: string;
  readonly manifestFiles: number;
  readonly reviewedFiles: number;
  readonly omittedFiles: number;
  readonly findings: number;
  readonly files: readonly ReviewRunSummaryFile[];
}
