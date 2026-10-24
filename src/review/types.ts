/**
 * Forge- and harness-independent review contracts.
 */

import type {
  CodeContextGraphReference,
  CodeContextProvider,
  CodeContextStatus,
} from '../code-context/artifact.js';

export type FindingScope = 'defects' | 'defects-and-risks';
export const FINDING_SCOPES: readonly FindingScope[] = ['defects', 'defects-and-risks'];

export type FindingCategory = 'correctness' | 'security' | 'regression' | 'testing' | 'operational' | 'maintainability';
export type ReviewDimension = FindingCategory | 'compatibility' | 'data-integrity' | 'architecture';
export type FindingClassification = 'defect' | 'risk' | 'test-gap' | 'design-debt' | 'question';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type FindingSide = 'LEFT' | 'RIGHT';
export type EvidenceRole =
  | 'missing-guard'
  | 'caller-assumption'
  | 'contract'
  | 'schema'
  | 'test-gap'
  | 'impact-path';
export type FindingReversibility = 'reversible' | 'partially-reversible' | 'irreversible' | 'unknown';
export type FindingVerificationStatus = 'unverified' | 'confirmed' | 'rejected' | 'inconclusive';
export type RemediationStatus = 'guidance' | 'proposed' | 'applicable' | 'verified' | 'rejected';

export interface SourceEvidence {
  readonly role: EvidenceRole;
  readonly revision: string;
  readonly path: string;
  /** Inclusive, source-resolved range; interior lines have no claimed text in this contract. */
  readonly startLine: number;
  readonly endLine: number;
  /** Exact content of startLine at revision/path; not a claim about the full range. */
  readonly evidence: string;
}

export type GraphReference = Readonly<CodeContextGraphReference>;

export type ImpactPathStatus = 'complete' | 'partial' | 'unresolved';

export interface ImpactPathStep {
  readonly from: string;
  readonly to: string;
  readonly relationship: string;
  readonly evidence: 'source' | 'graph';
  /** Index into supportingEvidence or graphReferences according to evidence. */
  readonly referenceIndex: number;
}

export interface ImpactPath {
  readonly status: ImpactPathStatus;
  readonly steps: readonly ImpactPathStep[];
  readonly limitation?: string | undefined;
}

export interface FindingVerification {
  readonly status: FindingVerificationStatus;
  readonly reason: string;
}

export interface ReviewFinding {
  readonly title: string;
  readonly dimensions: readonly ReviewDimension[];
  readonly category: FindingCategory;
  readonly classification: FindingClassification;
  readonly severity: FindingSeverity;
  readonly confidence: number;
  readonly side: FindingSide;
  /** Both trigger endpoints must be changed lines of this side. */
  readonly startLine: number;
  readonly endLine: number;
  /** Exact content of trigger startLine without its diff marker. */
  readonly evidence: string;
  readonly supportingEvidence: readonly SourceEvidence[];
  readonly graphReferences: readonly GraphReference[];
  readonly impactPath: ImpactPath;
  readonly behavioralContract: string;
  readonly failureScenario: string;
  readonly reachability: string;
  readonly rootCause: string;
  readonly impact: string;
  readonly blastRadius: string;
  readonly reversibility: FindingReversibility;
  readonly assumptions: readonly string[];
  readonly counterEvidence: readonly string[];
  readonly uncertainty: string;
  readonly fix: string;
  readonly regressionTest: string;
  readonly verification: FindingVerification;
  readonly remediationStatus: RemediationStatus;
  readonly suggestedChange?: string | undefined;
}

export interface ValidatedFinding extends ReviewFinding {
  readonly id: string;
}

/** A source-validated finding enriched for publication and remediation. */
export interface PublishedFinding extends Omit<ValidatedFinding, 'suggestedChange'> {
  readonly suggestion?: string | undefined;
  readonly fixPrompt: string;
}

export interface RejectedCandidate {
  readonly index: number;
  readonly stage: 'parse' | 'validation' | 'verification';
  readonly code: string;
  readonly reason: string;
}

export const MAX_REVIEW_REASON_CHARS = 500;
/** A truncated persisted reason includes one trailing ellipsis. */
export const MAX_PERSISTED_REVIEW_REASON_CHARS = MAX_REVIEW_REASON_CHARS + 1;

export type FileReviewOutcome = 'clean' | 'findings' | 'omitted';
export type FileReviewExecution = 'executed' | 'reused';
export type FileReviewErrorKind =
  | 'harness-failed'
  | 'harness-timeout'
  | 'invalid-output'
  | 'preparation-failed'
  | 'verification-failed';

export type ReviewCodeContextStatus = CodeContextStatus | 'disabled';
export type ReviewCodeContextReason =
  | 'not-configured'
  | 'artifact-invalid'
  | 'identity-mismatch'
  | 'artifact-unsupported'
  | 'artifact-unavailable'
  | 'provider-partial'
  | 'no-file-entry'
  | 'source-byte-limit';

export interface ReviewCodeContextCoverage {
  readonly status: ReviewCodeContextStatus;
  readonly provider: CodeContextProvider | null;
  readonly revision: string | null;
  readonly relatedSpans: number;
  readonly sourceBytes: number;
  readonly reason: ReviewCodeContextReason | null;
}

export interface ReviewCodeContextRunCoverage extends ReviewCodeContextCoverage {
  readonly filesWithContext: number;
}

export const FILE_REVIEW_RECORD_VERSION = 4 as const;

export interface FileVerificationCoverage {
  readonly status: 'not-applicable' | 'completed' | 'incomplete';
  readonly requested: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly durationMs: number;
  readonly reason?: string | undefined;
}

export interface FileFollowUpCoverage {
  readonly status: 'not-applicable' | 'completed' | 'incomplete';
  readonly requested: number;
  readonly completed: number;
  readonly omitted: number;
  readonly durationMs: number;
  readonly reason?: string | undefined;
}

export interface FileReviewRecord {
  readonly version: typeof FILE_REVIEW_RECORD_VERSION;
  readonly fileId: string;
  readonly path: string;
  readonly status: string;
  readonly harness: string;
  readonly model: string;
  readonly codeContext: ReviewCodeContextCoverage;
  readonly verification?: FileVerificationCoverage | undefined;
  readonly followUp?: FileFollowUpCoverage | undefined;
  readonly outcome: FileReviewOutcome;
  readonly errorKind?: FileReviewErrorKind | undefined;
  readonly reason?: string | undefined;
  readonly findings: readonly PublishedFinding[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
  readonly durationMs: number;
  /** Whether this run executed the harness or restored a validated semantic match. */
  readonly execution?: FileReviewExecution | undefined;
  /** Prior validated model time avoided by a reused record. */
  readonly savedDurationMs?: number | undefined;
}

/** Kept during the PR-contract migration for existing benchmark/report consumers. */
export const REVIEW_RUN_SUMMARY_VERSION = 3 as const;

export interface ReviewRunSummaryFile {
  readonly fileId: string;
  readonly path: string;
  readonly outcome: FileReviewOutcome;
  readonly errorKind?: FileReviewErrorKind | undefined;
  readonly codeContext: ReviewCodeContextCoverage;
  readonly execution?: FileReviewExecution | undefined;
  readonly savedDurationMs?: number | undefined;
  readonly findingCount: number;
  readonly findingSpans: readonly string[];
}

export interface ReviewReuseTelemetry {
  readonly version: 1;
  readonly status: 'disabled' | 'enabled';
  readonly restoredEntries: number;
  readonly invalidEntries: number;
  readonly reusedFiles: number;
  readonly executedFiles: number;
  readonly savedDurationMs: number;
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
  readonly codeContext: ReviewCodeContextRunCoverage;
  readonly reuse?: ReviewReuseTelemetry | undefined;
  readonly files: readonly ReviewRunSummaryFile[];
}

export type ReviewCoverageStatus = 'not-applicable' | 'completed' | 'incomplete' | 'unavailable';

export interface ReviewCoverageFacet {
  readonly status: ReviewCoverageStatus;
  readonly required: boolean;
  readonly reason: string;
}

export interface ReviewFileCoverage extends ReviewCoverageFacet {
  readonly considered: readonly string[];
  readonly omitted: readonly string[];
  readonly excluded: readonly string[];
}

export interface ReviewSpecialistCoverage extends ReviewCoverageFacet {
  readonly id: string;
}

export interface ReviewInspectionCoverage extends ReviewCoverageFacet {
  readonly kind: 'tests' | 'contracts' | 'schemas' | 'configuration';
}

export interface ReviewContextSourceCoverage extends ReviewCoverageFacet {
  readonly source: 'diff' | 'base-source' | 'head-source' | 'indexed-context';
}

export interface ReviewCodeIntelligenceCoverage extends ReviewCoverageFacet {
  readonly provider: CodeContextProvider | null;
  readonly baseSnapshot: string;
  readonly headSnapshot: string;
  readonly capabilities: readonly string[];
  readonly cache: 'restored' | 'built' | 'unknown' | 'not-applicable';
  readonly diagnostics: readonly string[];
}

export interface ReviewRelationshipCoverage {
  readonly sourceConfirmed: number;
  readonly providerDerived: number;
  readonly providerDisagreement: readonly string[];
  readonly unresolvedSymbols: readonly string[];
  readonly unsupportedLanguages: readonly string[];
  readonly dynamicBehaviorUncertainty: readonly string[];
}

export interface PullRequestReviewCoverage {
  readonly files: ReviewFileCoverage;
  readonly changedSymbols: ReviewCoverageFacet;
  readonly contextSources: readonly ReviewContextSourceCoverage[];
  readonly specialists: readonly ReviewSpecialistCoverage[];
  readonly verification?: ReviewCoverageFacet | undefined;
  readonly followUp?: ReviewCoverageFacet | undefined;
  readonly publication?: ReviewCoverageFacet | undefined;
  readonly inspections: readonly ReviewInspectionCoverage[];
  readonly codeIntelligence: ReviewCodeIntelligenceCoverage;
  readonly graphQueries: readonly ReviewCoverageFacet[];
  readonly impactTraversals: readonly ReviewCoverageFacet[];
  readonly relationships: ReviewRelationshipCoverage;
  readonly truncation: ReviewCoverageFacet;
  readonly rejectedCandidates: number;
  /** Successful verifier falsifications/duplicates, not required-coverage failures. */
  readonly verificationRejections?: number | undefined;
  readonly remediation: ReviewCoverageFacet;
  readonly fixVerification: ReviewCoverageFacet;
  readonly budgets: {
    readonly maximumFindingsPerFile: number;
    readonly indexedContextBytes: number;
    readonly indexedContextSpans: number;
  };
}

export interface ReviewLimitation {
  readonly code: string;
  readonly required: boolean;
  readonly message: string;
}

export type PullRequestVerdictStatus =
  | 'mergeable'
  | 'mergeable-after-verified-fixes'
  | 'human-decision-required'
  | 'inconclusive'
  | 'blocked';

export interface PullRequestVerdict {
  readonly status: PullRequestVerdictStatus;
  readonly reasons: readonly string[];
}

export interface PullRequestFinding extends PublishedFinding {
  readonly triggerFileId: string;
  readonly triggerPath: string;
}

export interface PullRequestReviewFile {
  readonly fileId: string;
  readonly path: string;
  readonly outcome: FileReviewOutcome;
  readonly findingIds: readonly string[];
  readonly rejectedCandidates: number;
  readonly codeContext: ReviewCodeContextCoverage;
}

export interface ReviewSynthesisGroup {
  readonly id: string;
  readonly rootCause: string;
  readonly status: 'coherent' | 'conflict';
  readonly triggers: readonly {
    readonly fileId: string;
    readonly findingId: string;
    readonly path: string;
    readonly side: FindingSide;
    readonly startLine: number;
    readonly endLine: number;
  }[];
  readonly supportingEvidence: readonly SourceEvidence[];
  readonly representative: { readonly fileId: string; readonly findingId: string } | null;
}

export interface ReviewSynthesisDecision {
  readonly fileId: string;
  readonly findingId: string;
  readonly groupId: string;
  readonly status: 'publish' | 'duplicate' | 'conflict' | 'file-budget' | 'comment-budget' | 'unverified';
  readonly reason: string;
}

export interface ReviewSynthesis {
  readonly version: 1;
  readonly groups: readonly ReviewSynthesisGroup[];
  readonly decisions: readonly ReviewSynthesisDecision[];
  readonly budgets: { readonly fileReviews: number; readonly inlineComments: number };
}

/** v1 records remain loadable; v2 carries deterministic synthesis when enabled. */
export const PULL_REQUEST_REVIEW_VERSION = 2 as const;

/** Primary machine-readable contract for one complete pull-request review. */
export interface PullRequestReviewRecord {
  readonly version: typeof PULL_REQUEST_REVIEW_VERSION;
  readonly harness: string;
  readonly model: string;
  readonly provider: string;
  readonly findingScope: FindingScope;
  readonly base: string;
  readonly head: string;
  readonly findings: readonly PullRequestFinding[];
  readonly synthesis?: ReviewSynthesis | undefined;
  readonly rejectedCandidates: readonly (RejectedCandidate & { readonly fileId: string; readonly path: string })[];
  readonly coverage: PullRequestReviewCoverage;
  readonly limitations: readonly ReviewLimitation[];
  readonly verdict: PullRequestVerdict;
  readonly files: readonly PullRequestReviewFile[];
  readonly legacySummaryVersion: typeof REVIEW_RUN_SUMMARY_VERSION;
}
