/**
 * Provider-neutral contracts for deterministic PR change-impact planning.
 *
 * Graph facts are derived evidence. Diff text and captured base/head source
 * remain authoritative for finding locations and evidence.
 */

export const CHANGE_IMPACT_MAP_VERSION = 1 as const;
export const CONTEXT_PLAN_VERSION = 1 as const;
export const GRAPH_DELTA_VERSION = 1 as const;

export type RevisionSide = 'base' | 'head';
export type CoverageStatus = 'complete' | 'partial' | 'unsupported' | 'unavailable';
export type AnalysisMode = 'file-only' | 'indexed-context' | 'full-impact';

export interface SourceSpan {
  readonly startLine: number;
  readonly endLine: number;
}

export interface FactProvenance {
  readonly provider: string;
  readonly providerVersion: string;
  readonly snapshotId: string;
  readonly revision: string;
  readonly queryId: string;
  readonly status: CoverageStatus;
}

export type GraphNodeRole =
  | 'entry-point'
  | 'contract'
  | 'test'
  | 'fixture'
  | 'state-read'
  | 'state-write'
  | 'event'
  | 'external-call'
  | 'resource-owner'
  | 'persistent-state'
  | 'configuration';

export interface GraphNode {
  /** Stable provider-neutral identity when identity is known across revisions. */
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly path: string;
  readonly span?: SourceSpan;
  readonly digest?: string;
  readonly signature?: string;
  readonly public?: boolean;
  readonly roles: readonly GraphNodeRole[];
  readonly ambiguous?: boolean;
  readonly provenance: FactProvenance;
}

export interface GraphEdge {
  /** Stable identity for this relationship within and across snapshots. */
  readonly id: string;
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly digest?: string;
  readonly approximate?: boolean;
  readonly provenance: FactProvenance;
}

export interface SnapshotUncertainty {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly queryId?: string;
}

export interface CodeIntelligenceSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly revision: string;
  readonly provider: string;
  readonly providerVersion: string;
  readonly coverage: CoverageStatus;
  readonly capabilities: readonly string[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly uncertainty: readonly SnapshotUncertainty[];
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X' | 'B';

export interface ChangedTarget {
  readonly id: string;
  readonly fileId: string;
  readonly status: ChangeStatus;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly baseNodeId?: string;
  readonly headNodeId?: string;
  readonly changedLines?: readonly number[];
}

export type NodeDeltaKind = 'added' | 'removed' | 'changed' | 'renamed' | 'unchanged';

export interface NodeDelta {
  readonly id: string;
  readonly kind: NodeDeltaKind;
  readonly base?: GraphNode;
  readonly head?: GraphNode;
  readonly changedFields: readonly string[];
}

export type EdgeDeltaKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface EdgeDelta {
  readonly id: string;
  readonly kind: EdgeDeltaKind;
  readonly base?: GraphEdge;
  readonly head?: GraphEdge;
  readonly changedFields: readonly string[];
}

export interface CapabilityDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly baseCoverage: CoverageStatus;
  readonly headCoverage: CoverageStatus;
}

export interface GraphDelta {
  readonly version: typeof GRAPH_DELTA_VERSION;
  readonly baseRevision: string | null;
  readonly headRevision: string | null;
  readonly nodes: readonly NodeDelta[];
  readonly edges: readonly EdgeDelta[];
  readonly unresolvedIdentity: readonly string[];
  readonly capabilities: CapabilityDelta;
}

export interface TraversalBudget {
  readonly maxDepth: number;
  readonly maxFanOut: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly maxWitnesses: number;
}

export interface ImpactConfiguration {
  readonly mode: AnalysisMode;
  readonly traversal: TraversalBudget;
}

export interface ChangeNeighborhood {
  readonly id: string;
  readonly targetIds: readonly string[];
  readonly paths: readonly string[];
  readonly relationEdgeIds: readonly string[];
  readonly partial: boolean;
}

export type ImpactConeKind = 'upstream' | 'downstream' | 'implementation' | 'test' | 'contract';

export type TruncationReason = 'depth' | 'fan-out' | 'nodes' | 'edges' | 'bytes' | 'time';

export interface PathWitness {
  readonly id: string;
  readonly cone: ImpactConeKind;
  readonly revision: RevisionSide;
  readonly triggerNodeId: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly reason: string;
  readonly approximate: boolean;
}

export interface ImpactCone {
  readonly id: string;
  readonly targetId: string;
  readonly kind: ImpactConeKind;
  readonly revision: RevisionSide;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly witnesses: readonly PathWitness[];
  readonly coverage: CoverageStatus;
  readonly partial: boolean;
  readonly truncationReasons: readonly TruncationReason[];
}

export interface StateEffectIndicator {
  readonly targetId: string;
  readonly nodeId: string;
  readonly role: Extract<
    GraphNodeRole,
    | 'state-read'
    | 'state-write'
    | 'event'
    | 'external-call'
    | 'resource-owner'
    | 'persistent-state'
  >;
  readonly certainty: 'exact' | 'approximate' | 'unknown';
}

export interface TestReachability {
  readonly targetId: string;
  readonly testNodeIds: readonly string[];
  readonly fixtureNodeIds: readonly string[];
  readonly status: 'discovered' | 'not-discovered' | 'unknown';
  readonly indirect: boolean;
}

export interface ContractSurfaceDelta {
  readonly addedNodeIds: readonly string[];
  readonly removedNodeIds: readonly string[];
  readonly changedNodeIds: readonly string[];
}

export interface ImpactUncertainty {
  readonly id: string;
  readonly code:
    | 'unsupported'
    | 'unavailable'
    | 'ambiguous-identity'
    | 'dynamic-behavior'
    | 'provider-disagreement'
    | 'truncated'
    | 'failed-query'
    | 'missing-capability'
    | 'unresolved-source';
  readonly message: string;
  readonly coverage: CoverageStatus;
  readonly path?: string;
  readonly nodeId?: string;
  readonly queryId?: string;
}

export type SpecialistDimension =
  | 'security-privacy'
  | 'data-integrity-concurrency'
  | 'reliability-recovery'
  | 'test-quality'
  | 'design-maintainability'
  | 'performance-resource-use'
  | 'observability'
  | 'compatibility';

export interface RiskProfile {
  /** Planning signals only. They are not findings and cannot block a change. */
  readonly blastRadius: 'small' | 'medium' | 'large' | 'unknown';
  readonly reversibility: 'easy' | 'moderate' | 'hard' | 'unknown';
  readonly specialistDimensions: readonly SpecialistDimension[];
  readonly reasons: readonly string[];
}

export interface ReviewIntent {
  readonly summary?: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface ChangeImpactMap {
  readonly version: typeof CHANGE_IMPACT_MAP_VERSION;
  readonly mode: AnalysisMode;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly intent: ReviewIntent;
  readonly changedTargets: readonly ChangedTarget[];
  readonly graphDelta: GraphDelta;
  readonly neighborhoods: readonly ChangeNeighborhood[];
  readonly cones: readonly ImpactCone[];
  readonly witnesses: readonly PathWitness[];
  readonly stateEffects: readonly StateEffectIndicator[];
  readonly testReachability: readonly TestReachability[];
  readonly contractSurface: ContractSurfaceDelta;
  readonly uncertainty: readonly ImpactUncertainty[];
  readonly risk: RiskProfile;
  readonly coverage: CoverageStatus;
}

export type ContextCategory =
  | 'diff-declaration'
  | 'base-head-span'
  | 'path-witness'
  | 'direct-relation-contract'
  | 'test-fixture'
  | 'state-effect-schema-config'
  | 'requirements-guidance'
  | 'secondary-graph';

export interface ContextCandidate {
  readonly id: string;
  readonly category: ContextCategory;
  readonly path: string;
  readonly revision: RevisionSide | 'repository';
  readonly span?: SourceSpan;
  readonly content: string;
  readonly digest: string;
  readonly selectionReason: string;
  readonly provenance?: FactProvenance;
  readonly nodeIds: readonly string[];
  readonly targetIds: readonly string[];
  readonly ambiguous: boolean;
  readonly truncated: boolean;
}

export interface ReviewQuestion {
  readonly id: string;
  readonly specialist: SpecialistDimension;
  readonly targetIds: readonly string[];
  readonly byteBudget: number;
  readonly tokenBudget: number;
}

export interface SelectedContextItem extends Omit<ContextCandidate, 'content'> {
  readonly content: string;
  readonly bytes: number;
  readonly tokenEstimate: number;
}

export interface QuestionContextPlan {
  readonly questionId: string;
  readonly specialist: SpecialistDimension;
  readonly items: readonly SelectedContextItem[];
  readonly omittedCandidateIds: readonly string[];
  readonly bytes: number;
  readonly tokenEstimate: number;
  readonly coverage: CoverageStatus;
}

export interface ReviewContextPlan {
  readonly version: typeof CONTEXT_PLAN_VERSION;
  readonly accounting: 'utf8-bytes-and-ceil-bytes-div-4';
  readonly questions: readonly QuestionContextPlan[];
}

export interface ChangeImpactInput {
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly intent?: ReviewIntent;
  readonly changedTargets: readonly ChangedTarget[];
  readonly baseSnapshot?: CodeIntelligenceSnapshot;
  readonly headSnapshot?: CodeIntelligenceSnapshot;
  readonly contextCandidates: readonly ContextCandidate[];
  readonly questions: readonly ReviewQuestion[];
  readonly configuration: ImpactConfiguration;
}

export interface ChangeImpactResult {
  readonly impactMap: ChangeImpactMap;
  readonly contextPlan: ReviewContextPlan;
}
