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
  readonly startLine: number;
  readonly endLine: number;
  /** Exact content of startLine at revision/path. */
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
  readonly stage: 'parse' | 'validation';
  readonly code: string;
  readonly reason: string;
}

export type FileReviewOutcome = 'clean' | 'findings' | 'omitted';
export type FileReviewErrorKind =
  | 'harness-failed'
  | 'harness-timeout'
  | 'invalid-output'
  | 'preparation-failed';

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

export interface FileReviewRecord {
  readonly version: typeof FILE_REVIEW_RECORD_VERSION;
  readonly fileId: string;
  readonly path: string;
  readonly status: string;
  readonly harness: string;
  readonly model: string;
  readonly codeContext: ReviewCodeContextCoverage;
  readonly outcome: FileReviewOutcome;
  readonly errorKind?: FileReviewErrorKind | undefined;
  readonly reason?: string | undefined;
  readonly findings: readonly PublishedFinding[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
  readonly durationMs: number;
}

/** Kept during the PR-contract migration for existing benchmark/report consumers. */
export const REVIEW_RUN_SUMMARY_VERSION = 3 as const;

export interface ReviewRunSummaryFile {
  readonly fileId: string;
  readonly path: string;
  readonly outcome: FileReviewOutcome;
  readonly errorKind?: FileReviewErrorKind | undefined;
  readonly codeContext: ReviewCodeContextCoverage;
  readonly findingCount: number;
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
  readonly codeContext: ReviewCodeContextRunCoverage;
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
  readonly inspections: readonly ReviewInspectionCoverage[];
  readonly codeIntelligence: ReviewCodeIntelligenceCoverage;
  readonly graphQueries: readonly ReviewCoverageFacet[];
  readonly impactTraversals: readonly ReviewCoverageFacet[];
  readonly relationships: ReviewRelationshipCoverage;
  readonly truncation: ReviewCoverageFacet;
  readonly rejectedCandidates: number;
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

export const PULL_REQUEST_REVIEW_VERSION = 1 as const;

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
  readonly rejectedCandidates: readonly (RejectedCandidate & { readonly fileId: string; readonly path: string })[];
  readonly coverage: PullRequestReviewCoverage;
  readonly limitations: readonly ReviewLimitation[];
  readonly verdict: PullRequestVerdict;
  readonly files: readonly PullRequestReviewFile[];
  readonly legacySummaryVersion: typeof REVIEW_RUN_SUMMARY_VERSION;
}
