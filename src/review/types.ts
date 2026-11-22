/** Established neutral finding/synthesis contracts, without archived executors or runtime validators. */
import type { CodeContextGraphReference } from '../code-context/provider.ts';
import type { CapturedRevision } from '../revision-source/types.ts';

export type FindingScope = 'defects' | 'defects-and-risks';

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

export interface PullRequestFinding extends PublishedFinding {
  readonly triggerFileId: string;
  readonly triggerPath: string;
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


/** Aggregate driver metadata, authoritative-context payloads and report migration fields are intentionally deferred. */
export type ReviewDocument = unknown;
export type ReviewReport = unknown;
export type AuthoritativeReviewContext = unknown;
export interface FileReviewInput {
  readonly capture: CapturedRevision;
  readonly fileId: string;
}
