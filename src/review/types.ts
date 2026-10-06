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
  readonly line: number;
  readonly evidence: string;
  readonly impact: string;
  readonly fix: string;
}

export interface ValidatedFinding extends ReviewFinding {
  readonly id: string;
}

export type FileReviewOutcome = 'clean' | 'findings' | 'omitted';

export type FileReviewErrorKind =
  | 'harness-failed'
  | 'harness-timeout'
  | 'invalid-output'
  | 'preparation-failed';

export const FILE_REVIEW_RECORD_VERSION = 1 as const;

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
  readonly findings: readonly ValidatedFinding[];
  readonly durationMs: number;
}

export const REVIEW_RUN_SUMMARY_VERSION = 1 as const;

export interface ReviewRunSummaryFile {
  readonly fileId: string;
  readonly path: string;
  readonly outcome: FileReviewOutcome;
  readonly errorKind?: FileReviewErrorKind | undefined;
  readonly findingCount: number;
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
