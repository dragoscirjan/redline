/**
 * Provider-neutral code-intelligence contracts.
 *
 * Providers produce derived evidence only. Diff text and captured source
 * remain authoritative for published finding locations and evidence.
 */

export const CODE_INTELLIGENCE_CONTRACT_VERSION = 1 as const;
export const CODE_INTELLIGENCE_SNAPSHOT_VERSION = 1 as const;
export const CODE_INTELLIGENCE_QUERY_VERSION = 1 as const;
export const CODE_INTELLIGENCE_RESULT_VERSION = 1 as const;
export const CODE_INTELLIGENCE_RECORDING_VERSION = 1 as const;

export const CODE_INTELLIGENCE_CAPABILITIES = [
  'symbol-definitions',
  'enclosing-declarations',
  'type-information',
  'references',
  'callers-callees',
  'implementations',
  'inheritance',
  'file-dependencies',
  'module-dependencies',
  'associated-tests',
  'configuration-references',
  'dependency-paths',
  'entry-terminal-relations',
  'execution-flows',
  'process-participation',
  'native-impact',
  'graph-delta',
  'incremental-update',
] as const;

export type CodeIntelligenceCapability = (typeof CODE_INTELLIGENCE_CAPABILITIES)[number];
export type RevisionSide = 'base' | 'head';
export type CoverageStatus = 'complete' | 'partial' | 'unsupported' | 'unavailable';
export type FactStatus = 'complete' | 'partial' | 'ambiguous' | 'truncated';
export type ProviderOperationStatus =
  | 'succeeded'
  | 'partial'
  | 'unsupported'
  | 'unavailable'
  | 'failed'
  | 'timed-out';
export type QueryResultStatus =
  | 'complete'
  | 'partial'
  | 'empty'
  | 'unsupported'
  | 'unavailable'
  | 'failed'
  | 'truncated'
  | 'ambiguous';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface SourceSpan {
  readonly startLine: number;
  readonly endLine: number;
}

export interface SourceProvenance {
  /** Repository-relative path within FactProvenance.revision. */
  readonly path: string;
  readonly span?: SourceSpan;
  readonly digest?: string;
}

export interface FactProvenance {
  readonly contractVersion: typeof CODE_INTELLIGENCE_CONTRACT_VERSION;
  readonly provider: string;
  readonly providerVersion: string;
  readonly adapterVersion: string;
  readonly snapshotId: string;
  readonly revision: string;
  readonly queryId: string;
  readonly retrievalReason: string;
  readonly status: FactStatus;
  readonly source?: SourceProvenance;
}

export interface ProviderExtension {
  readonly provider: string;
  readonly schema: string;
  readonly data: JsonValue;
}

export type GraphNodeKind =
  | 'file'
  | 'module'
  | 'symbol'
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'test'
  | 'fixture'
  | 'configuration'
  | 'entry-point'
  | 'state-store'
  | 'external-boundary'
  | `provider:${string}`;

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
  readonly kind: GraphNodeKind;
  readonly name: string;
  readonly path: string;
  readonly span?: SourceSpan;
  readonly digest?: string;
  readonly signature?: string;
  readonly public?: boolean;
  readonly roles: readonly GraphNodeRole[];
  readonly ambiguous?: boolean;
  readonly confidence?: number;
  readonly extension?: ProviderExtension;
  readonly provenance: FactProvenance;
}

export type GraphEdgeKind =
  | 'defines'
  | 'references'
  | 'calls'
  | 'implements'
  | 'extends'
  | 'overrides'
  | 'imports'
  | 'tests'
  | 'configures'
  | 'reads'
  | 'writes'
  | 'emits'
  | 'invokes'
  | 'contains'
  | `provider:${string}`;

export interface GraphEdge {
  /** Stable identity for this relationship within and across snapshots. */
  readonly id: string;
  readonly kind: GraphEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly digest?: string;
  readonly approximate?: boolean;
  readonly confidence?: number;
  readonly extension?: ProviderExtension;
  readonly provenance: FactProvenance;
}

export interface SnapshotUncertainty {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly queryId?: string;
}

export interface LanguageCoverage {
  readonly language: string;
  readonly status: CoverageStatus;
  readonly discoveredFiles: number;
  readonly indexedFiles: number;
  readonly reason?: string;
}

export type FileCoverageStatus = 'indexed' | 'unsupported' | 'skipped' | 'failed' | 'truncated';

export interface FileCoverage {
  readonly path: string;
  readonly status: FileCoverageStatus;
  readonly language?: string;
  readonly reason?: string;
}

export interface CodeIntelligenceSnapshot {
  readonly version: typeof CODE_INTELLIGENCE_SNAPSHOT_VERSION;
  readonly contractVersion: typeof CODE_INTELLIGENCE_CONTRACT_VERSION;
  readonly id: string;
  readonly repositoryId: string;
  readonly revision: string;
  readonly sourceTreeDigest: string;
  readonly provider: string;
  readonly providerVersion: string;
  readonly adapterVersion: string;
  readonly schemaVersion: string;
  readonly configurationDigest: string;
  readonly coverage: CoverageStatus;
  readonly capabilities: readonly CodeIntelligenceCapability[];
  readonly languageCoverage: readonly LanguageCoverage[];
  readonly fileCoverage: readonly FileCoverage[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly uncertainty: readonly SnapshotUncertainty[];
}

export interface NormalizedNodeFact {
  readonly version: typeof CODE_INTELLIGENCE_CONTRACT_VERSION;
  readonly kind: 'node';
  readonly node: GraphNode;
}

export interface NormalizedEdgeFact {
  readonly version: typeof CODE_INTELLIGENCE_CONTRACT_VERSION;
  readonly kind: 'edge';
  readonly edge: GraphEdge;
}

export type NormalizedGraphFact = NormalizedNodeFact | NormalizedEdgeFact;

export interface CapabilityDeclaration {
  readonly capability: CodeIntelligenceCapability;
  readonly status: 'supported' | 'experimental' | 'unsupported';
  readonly detail?: string;
}

export interface ProviderLicense {
  readonly name: string;
  readonly spdx: string | null;
  readonly url: string;
  readonly redistribution: 'allowed' | 'conditional' | 'prohibited' | 'unknown';
  readonly notice?: string;
}

export interface ProviderDistribution {
  readonly source: string;
  readonly pinnedVersion: string;
  readonly digest?: string;
}

export interface CodeIntelligenceProviderDescriptor {
  readonly contractVersion: typeof CODE_INTELLIGENCE_CONTRACT_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly providerVersion: string;
  readonly adapterVersion: string;
  readonly schemaVersion: string;
  readonly capabilities: readonly CapabilityDeclaration[];
  readonly languages: readonly string[];
  readonly license: ProviderLicense;
  readonly distribution: ProviderDistribution;
}

export interface QueryBudget {
  readonly maxDepth: number;
  readonly maxFanOut: number;
  readonly maxResults: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
}

export type QueryTarget =
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'path'; readonly path: string; readonly span?: SourceSpan }
  | { readonly kind: 'repository' };

export interface CodeIntelligenceQuery {
  readonly version: typeof CODE_INTELLIGENCE_QUERY_VERSION;
  readonly id: string;
  readonly snapshotId: string;
  readonly revision: string;
  readonly capability: CodeIntelligenceCapability;
  readonly target: QueryTarget;
  readonly retrievalReason: string;
  readonly budget: QueryBudget;
}

export type QueryTruncationReason = 'depth' | 'fan-out' | 'results' | 'bytes' | 'time';

export interface ProviderDiagnostic {
  readonly level: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
}

export interface CodeIntelligenceQueryResult {
  readonly version: typeof CODE_INTELLIGENCE_RESULT_VERSION;
  readonly queryId: string;
  readonly snapshotId: string;
  readonly revision: string;
  readonly provider: string;
  readonly providerVersion: string;
  readonly status: QueryResultStatus;
  readonly facts: readonly NormalizedGraphFact[];
  readonly diagnostics: readonly ProviderDiagnostic[];
  readonly truncationReasons: readonly QueryTruncationReason[];
  /** Largest traversal depth actually reached; zero for non-traversal queries. */
  readonly observedDepth: number;
  /** Largest number of relationships expanded from one node; zero when none were expanded. */
  readonly observedMaxFanOut: number;
  readonly bytes: number;
  readonly durationMs: number;
}

export interface SnapshotBuildRequest {
  readonly repositoryId: string;
  readonly sourceDirectory: string;
  readonly revision: string;
  readonly sourceTreeDigest: string;
  readonly configurationDigest: string;
  readonly workDirectory: string;
  readonly timeoutMs: number;
}

export interface SnapshotOpenRequest {
  readonly snapshotId: string;
  readonly repositoryId: string;
  readonly revision: string;
  readonly sourceTreeDigest: string;
  readonly configurationDigest: string;
  readonly storagePath: string;
  readonly timeoutMs: number;
}

export type SnapshotOperationResult =
  | {
      readonly status: Extract<ProviderOperationStatus, 'succeeded' | 'partial'>;
      readonly snapshot: CodeIntelligenceSnapshot;
      readonly diagnostics: readonly ProviderDiagnostic[];
      readonly durationMs: number;
    }
  | {
      readonly status: Exclude<ProviderOperationStatus, 'succeeded' | 'partial'>;
      readonly snapshot?: never;
      readonly diagnostics: readonly ProviderDiagnostic[];
      readonly durationMs: number;
    };

export interface CodeIntelligenceProvider {
  readonly id: string;
  describe(): Promise<CodeIntelligenceProviderDescriptor>;
  buildSnapshot(request: SnapshotBuildRequest): Promise<SnapshotOperationResult>;
  openSnapshot(request: SnapshotOpenRequest): Promise<SnapshotOperationResult>;
  query(query: CodeIntelligenceQuery): Promise<CodeIntelligenceQueryResult>;
  close(): Promise<void>;
}

export type CodeIntelligenceProviderFactory = () => CodeIntelligenceProvider;

export interface CodeIntelligenceProviderRegistration {
  readonly id: string;
  readonly create: CodeIntelligenceProviderFactory;
}

/** Serialized provider output used by deterministic adapter conformance tests. */
export interface CodeIntelligenceRecording {
  readonly version: typeof CODE_INTELLIGENCE_RECORDING_VERSION;
  readonly descriptor: CodeIntelligenceProviderDescriptor;
  readonly snapshot: CodeIntelligenceSnapshot;
  readonly queryResults: readonly CodeIntelligenceQueryResult[];
}
