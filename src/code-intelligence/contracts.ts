import { createHash } from 'node:crypto';
import {
  CODE_INTELLIGENCE_CAPABILITIES,
  CODE_INTELLIGENCE_CONTRACT_VERSION,
  CODE_INTELLIGENCE_QUERY_VERSION,
  CODE_INTELLIGENCE_RECORDING_VERSION,
  CODE_INTELLIGENCE_RESULT_VERSION,
  CODE_INTELLIGENCE_SNAPSHOT_VERSION,
  type CapabilityDeclaration,
  type CodeIntelligenceCapability,
  type CodeIntelligenceProviderDescriptor,
  type CodeIntelligenceQuery,
  type CodeIntelligenceQueryResult,
  type CodeIntelligenceRecording,
  type CodeIntelligenceSnapshot,
  type CoverageStatus,
  type FactProvenance,
  type FactStatus,
  type FileCoverage,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphNode,
  type GraphNodeKind,
  type GraphNodeRole,
  type JsonValue,
  type LanguageCoverage,
  type NormalizedGraphFact,
  type ProviderDiagnostic,
  type ProviderExtension,
  type QueryBudget,
  type QueryResultStatus,
  type QueryTarget,
  type QueryTruncationReason,
  type SnapshotUncertainty,
  type SourceProvenance,
  type SourceSpan,
} from './types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const DIGEST_PATTERN = /^(?:sha256:[0-9a-f]{64}|sha512:[0-9a-f]{128})$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_PATH_BYTES = 4_096;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_EXTENSION_BYTES = 64 * 1024;
const MAX_FACTS = 100_000;
const MAX_COVERAGE_ENTRIES = 100_000;
const MAX_DIAGNOSTICS = 1_000;

const COVERAGE_STATUSES = new Set<CoverageStatus>(['complete', 'partial', 'unsupported', 'unavailable']);
const FACT_STATUSES = new Set<FactStatus>(['complete', 'partial', 'ambiguous', 'truncated']);
const QUERY_RESULT_STATUSES = new Set<QueryResultStatus>([
  'complete',
  'partial',
  'empty',
  'unsupported',
  'unavailable',
  'failed',
  'truncated',
  'ambiguous',
]);
const NODE_ROLES = new Set<GraphNodeRole>([
  'entry-point',
  'contract',
  'test',
  'fixture',
  'state-read',
  'state-write',
  'event',
  'external-call',
  'resource-owner',
  'persistent-state',
  'configuration',
]);
const NODE_KINDS = new Set<string>([
  'file',
  'module',
  'symbol',
  'function',
  'method',
  'class',
  'interface',
  'type',
  'test',
  'fixture',
  'configuration',
  'entry-point',
  'state-store',
  'external-boundary',
]);
const EDGE_KINDS = new Set<string>([
  'defines',
  'references',
  'calls',
  'implements',
  'extends',
  'overrides',
  'imports',
  'tests',
  'configures',
  'reads',
  'writes',
  'emits',
  'invokes',
  'contains',
]);
const TRUNCATION_REASONS = new Set<QueryTruncationReason>(['depth', 'fan-out', 'results', 'bytes', 'time']);
const CAPABILITIES = new Set<string>(CODE_INTELLIGENCE_CAPABILITIES);

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function stringValue(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return value;
}

function optionalString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES): string | undefined {
  return value === undefined ? undefined : stringValue(value, label, maxBytes);
}

function identifier(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 256);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} has an invalid identifier`);
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 136);
  if (!DIGEST_PATTERN.test(parsed)) throw new Error(`${label} must be a labelled SHA-256 or SHA-512 digest`);
  return parsed;
}

function repositoryPath(value: unknown, label: string): string {
  const parsed = stringValue(value, label, MAX_PATH_BYTES);
  const segments = parsed.split('/');
  if (
    parsed.startsWith('/') ||
    parsed.includes('\\') ||
    parsed.includes('\0') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) throw new Error(`${label} must be a normalized repository-relative path`);
  return parsed;
}

function revision(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 64);
  if (!COMMIT_PATTERN.test(parsed)) throw new Error(`${label} must be a 40- or 64-character commit digest`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function confidence(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

function arrayValue(value: unknown, label: string, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new Error(`${label} is unsupported: ${String(value)}`);
  return value as T;
}

function sortedUnique(values: readonly string[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    if (current === undefined) continue;
    const previous = values[index - 1];
    if (previous !== undefined && previous >= current) {
      throw new Error(`${label} must be sorted by raw string value without duplicates`);
    }
  }
}

function parseStringArray(value: unknown, label: string, maxLength = 1_000): string[] {
  const parsed = arrayValue(value, label, maxLength).map((item, index) => stringValue(item, `${label}[${index}]`));
  sortedUnique(parsed, label);
  return parsed;
}

function parseSpan(value: unknown, label: string): SourceSpan {
  const input = record(value, label);
  onlyKeys(input, ['startLine', 'endLine'], label);
  const startLine = positiveInteger(input['startLine'], `${label}.startLine`);
  const endLine = positiveInteger(input['endLine'], `${label}.endLine`);
  if (endLine < startLine) throw new Error(`${label}.endLine must not precede startLine`);
  return { startLine, endLine };
}

function parseJsonValue(value: unknown, label: string, depth = 0): JsonValue {
  if (depth > 20) throw new Error(`${label} exceeds the maximum JSON nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => parseJsonValue(item, `${label}[${index}]`, depth + 1));
  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) output[key] = parseJsonValue(value[key], `${label}.${key}`, depth + 1);
    return output;
  }
  throw new Error(`${label} must contain only JSON values`);
}

function parseExtension(value: unknown, label: string): ProviderExtension {
  const input = record(value, label);
  onlyKeys(input, ['provider', 'schema', 'data'], label);
  if (input['data'] === undefined) throw new Error(`${label}.data is required`);
  const data = parseJsonValue(input['data'], `${label}.data`);
  if (byteLength(JSON.stringify(data)) > MAX_EXTENSION_BYTES) {
    throw new Error(`${label}.data exceeds ${MAX_EXTENSION_BYTES} bytes`);
  }
  return {
    provider: identifier(input['provider'], `${label}.provider`),
    schema: stringValue(input['schema'], `${label}.schema`, 256),
    data,
  };
}

function parseSource(value: unknown, label: string): SourceProvenance {
  const input = record(value, label);
  onlyKeys(input, ['path', 'span', 'digest'], label);
  const path = repositoryPath(input['path'], `${label}.path`);
  const span = input['span'] === undefined ? undefined : parseSpan(input['span'], `${label}.span`);
  const sourceDigest = input['digest'] === undefined ? undefined : digest(input['digest'], `${label}.digest`);
  return { path, ...(span === undefined ? {} : { span }), ...(sourceDigest === undefined ? {} : { digest: sourceDigest }) };
}

function parseProvenance(value: unknown, label: string): FactProvenance {
  const input = record(value, label);
  onlyKeys(input, [
    'contractVersion',
    'provider',
    'providerVersion',
    'adapterVersion',
    'snapshotId',
    'revision',
    'queryId',
    'retrievalReason',
    'status',
    'source',
  ], label);
  if (input['contractVersion'] !== CODE_INTELLIGENCE_CONTRACT_VERSION) {
    throw new Error(`${label}.contractVersion must be ${CODE_INTELLIGENCE_CONTRACT_VERSION}`);
  }
  const source = input['source'] === undefined ? undefined : parseSource(input['source'], `${label}.source`);
  return {
    contractVersion: CODE_INTELLIGENCE_CONTRACT_VERSION,
    provider: identifier(input['provider'], `${label}.provider`),
    providerVersion: stringValue(input['providerVersion'], `${label}.providerVersion`, 256),
    adapterVersion: stringValue(input['adapterVersion'], `${label}.adapterVersion`, 256),
    snapshotId: identifier(input['snapshotId'], `${label}.snapshotId`),
    revision: revision(input['revision'], `${label}.revision`),
    queryId: identifier(input['queryId'], `${label}.queryId`),
    retrievalReason: stringValue(input['retrievalReason'], `${label}.retrievalReason`),
    status: enumValue(input['status'], FACT_STATUSES, `${label}.status`),
    ...(source === undefined ? {} : { source }),
  };
}

function parseNodeKind(value: unknown, label: string): GraphNodeKind {
  const parsed = stringValue(value, label, 256);
  if (!NODE_KINDS.has(parsed) && !/^provider:[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(parsed)) {
    throw new Error(`${label} is not a normalized or provider-prefixed node kind`);
  }
  return parsed as GraphNodeKind;
}

function parseEdgeKind(value: unknown, label: string): GraphEdgeKind {
  const parsed = stringValue(value, label, 256);
  if (!EDGE_KINDS.has(parsed) && !/^provider:[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(parsed)) {
    throw new Error(`${label} is not a normalized or provider-prefixed edge kind`);
  }
  return parsed as GraphEdgeKind;
}

function parseNode(value: unknown, label: string): GraphNode {
  const input = record(value, label);
  onlyKeys(input, [
    'id', 'kind', 'name', 'path', 'span', 'digest', 'signature', 'public', 'roles',
    'ambiguous', 'confidence', 'extension', 'provenance',
  ], label);
  const roles = arrayValue(input['roles'], `${label}.roles`, NODE_ROLES.size)
    .map((item, index) => enumValue(item, NODE_ROLES, `${label}.roles[${index}]`));
  sortedUnique(roles, `${label}.roles`);
  const span = input['span'] === undefined ? undefined : parseSpan(input['span'], `${label}.span`);
  const nodeDigest = input['digest'] === undefined ? undefined : digest(input['digest'], `${label}.digest`);
  const signature = optionalString(input['signature'], `${label}.signature`);
  const isPublic = input['public'] === undefined ? undefined : booleanValue(input['public'], `${label}.public`);
  const ambiguous = input['ambiguous'] === undefined ? undefined : booleanValue(input['ambiguous'], `${label}.ambiguous`);
  const nodeConfidence = input['confidence'] === undefined ? undefined : confidence(input['confidence'], `${label}.confidence`);
  const extension = input['extension'] === undefined ? undefined : parseExtension(input['extension'], `${label}.extension`);
  return {
    id: identifier(input['id'], `${label}.id`),
    kind: parseNodeKind(input['kind'], `${label}.kind`),
    name: stringValue(input['name'], `${label}.name`),
    path: repositoryPath(input['path'], `${label}.path`),
    ...(span === undefined ? {} : { span }),
    ...(nodeDigest === undefined ? {} : { digest: nodeDigest }),
    ...(signature === undefined ? {} : { signature }),
    ...(isPublic === undefined ? {} : { public: isPublic }),
    roles,
    ...(ambiguous === undefined ? {} : { ambiguous }),
    ...(nodeConfidence === undefined ? {} : { confidence: nodeConfidence }),
    ...(extension === undefined ? {} : { extension }),
    provenance: parseProvenance(input['provenance'], `${label}.provenance`),
  };
}

function parseEdge(value: unknown, label: string): GraphEdge {
  const input = record(value, label);
  onlyKeys(input, ['id', 'kind', 'from', 'to', 'digest', 'approximate', 'confidence', 'extension', 'provenance'], label);
  const edgeDigest = input['digest'] === undefined ? undefined : digest(input['digest'], `${label}.digest`);
  const approximate = input['approximate'] === undefined ? undefined : booleanValue(input['approximate'], `${label}.approximate`);
  const edgeConfidence = input['confidence'] === undefined ? undefined : confidence(input['confidence'], `${label}.confidence`);
  const extension = input['extension'] === undefined ? undefined : parseExtension(input['extension'], `${label}.extension`);
  return {
    id: identifier(input['id'], `${label}.id`),
    kind: parseEdgeKind(input['kind'], `${label}.kind`),
    from: identifier(input['from'], `${label}.from`),
    to: identifier(input['to'], `${label}.to`),
    ...(edgeDigest === undefined ? {} : { digest: edgeDigest }),
    ...(approximate === undefined ? {} : { approximate }),
    ...(edgeConfidence === undefined ? {} : { confidence: edgeConfidence }),
    ...(extension === undefined ? {} : { extension }),
    provenance: parseProvenance(input['provenance'], `${label}.provenance`),
  };
}

function parseCapability(value: unknown, label: string): CodeIntelligenceCapability {
  return enumValue(value, CAPABILITIES as ReadonlySet<CodeIntelligenceCapability>, label);
}

function parseLanguageCoverage(value: unknown, label: string): LanguageCoverage {
  const input = record(value, label);
  onlyKeys(input, ['language', 'status', 'discoveredFiles', 'indexedFiles', 'reason'], label);
  const discoveredFiles = nonNegativeInteger(input['discoveredFiles'], `${label}.discoveredFiles`);
  const indexedFiles = nonNegativeInteger(input['indexedFiles'], `${label}.indexedFiles`);
  if (indexedFiles > discoveredFiles) throw new Error(`${label}.indexedFiles cannot exceed discoveredFiles`);
  const status = enumValue(input['status'], COVERAGE_STATUSES, `${label}.status`);
  if (status === 'complete' && indexedFiles !== discoveredFiles) {
    throw new Error(`${label} complete coverage requires every discovered file to be indexed`);
  }
  const reason = optionalString(input['reason'], `${label}.reason`);
  return {
    language: stringValue(input['language'], `${label}.language`, 128),
    status,
    discoveredFiles,
    indexedFiles,
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseFileCoverage(value: unknown, label: string): FileCoverage {
  const input = record(value, label);
  onlyKeys(input, ['path', 'status', 'language', 'reason'], label);
  const status = enumValue(
    input['status'],
    new Set<FileCoverage['status']>(['indexed', 'unsupported', 'skipped', 'failed', 'truncated']),
    `${label}.status`,
  );
  const language = optionalString(input['language'], `${label}.language`, 128);
  const reason = optionalString(input['reason'], `${label}.reason`);
  return {
    path: repositoryPath(input['path'], `${label}.path`),
    status,
    ...(language === undefined ? {} : { language }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseUncertainty(value: unknown, label: string): SnapshotUncertainty {
  const input = record(value, label);
  onlyKeys(input, ['code', 'message', 'path', 'nodeId', 'queryId'], label);
  const path = input['path'] === undefined ? undefined : repositoryPath(input['path'], `${label}.path`);
  const nodeId = input['nodeId'] === undefined ? undefined : identifier(input['nodeId'], `${label}.nodeId`);
  const queryId = input['queryId'] === undefined ? undefined : identifier(input['queryId'], `${label}.queryId`);
  return {
    code: identifier(input['code'], `${label}.code`),
    message: stringValue(input['message'], `${label}.message`),
    ...(path === undefined ? {} : { path }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(queryId === undefined ? {} : { queryId }),
  };
}

function assertFactIdentity(
  provenance: FactProvenance,
  snapshot: Pick<CodeIntelligenceSnapshot, 'id' | 'revision' | 'provider' | 'providerVersion' | 'adapterVersion'>,
  label: string,
): void {
  if (
    provenance.snapshotId !== snapshot.id ||
    provenance.revision !== snapshot.revision ||
    provenance.provider !== snapshot.provider ||
    provenance.providerVersion !== snapshot.providerVersion ||
    provenance.adapterVersion !== snapshot.adapterVersion
  ) throw new Error(`${label} provenance does not match its snapshot identity`);
}

/** Parses and validates a normalized immutable snapshot from an adapter or recording. */
export function parseCodeIntelligenceSnapshot(value: unknown): CodeIntelligenceSnapshot {
  const input = record(value, 'snapshot');
  onlyKeys(input, [
    'version', 'contractVersion', 'id', 'repositoryId', 'revision', 'sourceTreeDigest',
    'provider', 'providerVersion', 'adapterVersion', 'schemaVersion', 'configurationDigest',
    'coverage', 'capabilities', 'languageCoverage', 'fileCoverage', 'nodes', 'edges', 'uncertainty',
  ], 'snapshot');
  if (input['version'] !== CODE_INTELLIGENCE_SNAPSHOT_VERSION) {
    throw new Error(`snapshot.version must be ${CODE_INTELLIGENCE_SNAPSHOT_VERSION}`);
  }
  if (input['contractVersion'] !== CODE_INTELLIGENCE_CONTRACT_VERSION) {
    throw new Error(`snapshot.contractVersion must be ${CODE_INTELLIGENCE_CONTRACT_VERSION}`);
  }
  const capabilities = arrayValue(input['capabilities'], 'snapshot.capabilities', CODE_INTELLIGENCE_CAPABILITIES.length)
    .map((item, index) => parseCapability(item, `snapshot.capabilities[${index}]`));
  sortedUnique(capabilities, 'snapshot.capabilities');
  const languageCoverage = arrayValue(input['languageCoverage'], 'snapshot.languageCoverage', MAX_COVERAGE_ENTRIES)
    .map((item, index) => parseLanguageCoverage(item, `snapshot.languageCoverage[${index}]`));
  sortedUnique(languageCoverage.map((item) => item.language), 'snapshot.languageCoverage');
  const fileCoverage = arrayValue(input['fileCoverage'], 'snapshot.fileCoverage', MAX_COVERAGE_ENTRIES)
    .map((item, index) => parseFileCoverage(item, `snapshot.fileCoverage[${index}]`));
  sortedUnique(fileCoverage.map((item) => item.path), 'snapshot.fileCoverage');
  const nodes = arrayValue(input['nodes'], 'snapshot.nodes', MAX_FACTS)
    .map((item, index) => parseNode(item, `snapshot.nodes[${index}]`));
  sortedUnique(nodes.map((item) => item.id), 'snapshot.nodes');
  const edges = arrayValue(input['edges'], 'snapshot.edges', MAX_FACTS)
    .map((item, index) => parseEdge(item, `snapshot.edges[${index}]`));
  sortedUnique(edges.map((item) => item.id), 'snapshot.edges');
  const uncertainty = arrayValue(input['uncertainty'], 'snapshot.uncertainty', MAX_FACTS)
    .map((item, index) => parseUncertainty(item, `snapshot.uncertainty[${index}]`));
  const snapshot: CodeIntelligenceSnapshot = {
    version: CODE_INTELLIGENCE_SNAPSHOT_VERSION,
    contractVersion: CODE_INTELLIGENCE_CONTRACT_VERSION,
    id: identifier(input['id'], 'snapshot.id'),
    repositoryId: identifier(input['repositoryId'], 'snapshot.repositoryId'),
    revision: revision(input['revision'], 'snapshot.revision'),
    sourceTreeDigest: digest(input['sourceTreeDigest'], 'snapshot.sourceTreeDigest'),
    provider: identifier(input['provider'], 'snapshot.provider'),
    providerVersion: stringValue(input['providerVersion'], 'snapshot.providerVersion', 256),
    adapterVersion: stringValue(input['adapterVersion'], 'snapshot.adapterVersion', 256),
    schemaVersion: stringValue(input['schemaVersion'], 'snapshot.schemaVersion', 256),
    configurationDigest: digest(input['configurationDigest'], 'snapshot.configurationDigest'),
    coverage: enumValue(input['coverage'], COVERAGE_STATUSES, 'snapshot.coverage'),
    capabilities,
    languageCoverage,
    fileCoverage,
    nodes,
    edges,
    uncertainty,
  };
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    assertFactIdentity(node.provenance, snapshot, `node ${node.id}`);
    const source = node.provenance.source;
    if (source !== undefined && source.path !== node.path) {
      throw new Error(`node ${node.id} source provenance does not match its normalized path`);
    }
    if (
      source?.span !== undefined &&
      node.span !== undefined &&
      (source.span.startLine !== node.span.startLine || source.span.endLine !== node.span.endLine)
    ) throw new Error(`node ${node.id} source provenance does not match its normalized span`);
  }
  for (const edge of edges) {
    assertFactIdentity(edge.provenance, snapshot, `edge ${edge.id}`);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(`edge ${edge.id} references an unknown node`);
  }
  if (
    snapshot.coverage === 'complete' &&
    (languageCoverage.some((item) => item.status !== 'complete') || fileCoverage.some((item) => item.status !== 'indexed'))
  ) throw new Error('snapshot.coverage cannot be complete when a language or file has reduced coverage');
  return snapshot;
}

function parseCapabilityDeclaration(value: unknown, label: string): CapabilityDeclaration {
  const input = record(value, label);
  onlyKeys(input, ['capability', 'status', 'detail'], label);
  const detail = optionalString(input['detail'], `${label}.detail`);
  return {
    capability: parseCapability(input['capability'], `${label}.capability`),
    status: enumValue(
      input['status'],
      new Set<CapabilityDeclaration['status']>(['supported', 'experimental', 'unsupported']),
      `${label}.status`,
    ),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Parses provider identity, capability, version, distribution, and licensing metadata. */
export function parseCodeIntelligenceProviderDescriptor(value: unknown): CodeIntelligenceProviderDescriptor {
  const input = record(value, 'provider descriptor');
  onlyKeys(input, [
    'contractVersion', 'id', 'displayName', 'providerVersion', 'adapterVersion', 'schemaVersion',
    'capabilities', 'languages', 'license', 'distribution',
  ], 'provider descriptor');
  if (input['contractVersion'] !== CODE_INTELLIGENCE_CONTRACT_VERSION) {
    throw new Error(`provider descriptor.contractVersion must be ${CODE_INTELLIGENCE_CONTRACT_VERSION}`);
  }
  const capabilities = arrayValue(input['capabilities'], 'provider descriptor.capabilities', CODE_INTELLIGENCE_CAPABILITIES.length)
    .map((item, index) => parseCapabilityDeclaration(item, `provider descriptor.capabilities[${index}]`));
  sortedUnique(capabilities.map((item) => item.capability), 'provider descriptor.capabilities');
  const licenseInput = record(input['license'], 'provider descriptor.license');
  onlyKeys(licenseInput, ['name', 'spdx', 'url', 'redistribution', 'notice'], 'provider descriptor.license');
  const spdx = licenseInput['spdx'] === null ? null : stringValue(licenseInput['spdx'], 'provider descriptor.license.spdx', 128);
  const notice = optionalString(licenseInput['notice'], 'provider descriptor.license.notice');
  const distributionInput = record(input['distribution'], 'provider descriptor.distribution');
  onlyKeys(distributionInput, ['source', 'pinnedVersion', 'digest'], 'provider descriptor.distribution');
  const distributionDigest = distributionInput['digest'] === undefined
    ? undefined
    : digest(distributionInput['digest'], 'provider descriptor.distribution.digest');
  const providerVersion = stringValue(input['providerVersion'], 'provider descriptor.providerVersion', 256);
  const pinnedVersion = stringValue(distributionInput['pinnedVersion'], 'provider descriptor.distribution.pinnedVersion', 256);
  if (providerVersion !== pinnedVersion) {
    throw new Error('provider descriptor.distribution.pinnedVersion must match providerVersion');
  }
  return {
    contractVersion: CODE_INTELLIGENCE_CONTRACT_VERSION,
    id: identifier(input['id'], 'provider descriptor.id'),
    displayName: stringValue(input['displayName'], 'provider descriptor.displayName', 256),
    providerVersion,
    adapterVersion: stringValue(input['adapterVersion'], 'provider descriptor.adapterVersion', 256),
    schemaVersion: stringValue(input['schemaVersion'], 'provider descriptor.schemaVersion', 256),
    capabilities,
    languages: parseStringArray(input['languages'], 'provider descriptor.languages'),
    license: {
      name: stringValue(licenseInput['name'], 'provider descriptor.license.name', 256),
      spdx,
      url: stringValue(licenseInput['url'], 'provider descriptor.license.url', 2_048),
      redistribution: enumValue(
        licenseInput['redistribution'],
        new Set(['allowed', 'conditional', 'prohibited', 'unknown'] as const),
        'provider descriptor.license.redistribution',
      ),
      ...(notice === undefined ? {} : { notice }),
    },
    distribution: {
      source: stringValue(distributionInput['source'], 'provider descriptor.distribution.source', 2_048),
      pinnedVersion,
      ...(distributionDigest === undefined ? {} : { digest: distributionDigest }),
    },
  };
}

function parseBudget(value: unknown, label: string): QueryBudget {
  const input = record(value, label);
  onlyKeys(input, ['maxDepth', 'maxFanOut', 'maxResults', 'maxBytes', 'maxDurationMs'], label);
  return {
    maxDepth: positiveInteger(input['maxDepth'], `${label}.maxDepth`),
    maxFanOut: positiveInteger(input['maxFanOut'], `${label}.maxFanOut`),
    maxResults: positiveInteger(input['maxResults'], `${label}.maxResults`),
    maxBytes: positiveInteger(input['maxBytes'], `${label}.maxBytes`),
    maxDurationMs: positiveInteger(input['maxDurationMs'], `${label}.maxDurationMs`),
  };
}

function parseTarget(value: unknown, label: string): QueryTarget {
  const input = record(value, label);
  const kind = stringValue(input['kind'], `${label}.kind`, 32);
  if (kind === 'repository') {
    onlyKeys(input, ['kind'], label);
    return { kind };
  }
  if (kind === 'node') {
    onlyKeys(input, ['kind', 'nodeId'], label);
    return { kind, nodeId: identifier(input['nodeId'], `${label}.nodeId`) };
  }
  if (kind === 'path') {
    onlyKeys(input, ['kind', 'path', 'span'], label);
    const span = input['span'] === undefined ? undefined : parseSpan(input['span'], `${label}.span`);
    return {
      kind,
      path: repositoryPath(input['path'], `${label}.path`),
      ...(span === undefined ? {} : { span }),
    };
  }
  throw new Error(`${label}.kind is unsupported: ${kind}`);
}

export function parseCodeIntelligenceQuery(value: unknown): CodeIntelligenceQuery {
  const input = record(value, 'query');
  onlyKeys(input, ['version', 'id', 'snapshotId', 'revision', 'capability', 'target', 'retrievalReason', 'budget'], 'query');
  if (input['version'] !== CODE_INTELLIGENCE_QUERY_VERSION) {
    throw new Error(`query.version must be ${CODE_INTELLIGENCE_QUERY_VERSION}`);
  }
  return {
    version: CODE_INTELLIGENCE_QUERY_VERSION,
    id: identifier(input['id'], 'query.id'),
    snapshotId: identifier(input['snapshotId'], 'query.snapshotId'),
    revision: revision(input['revision'], 'query.revision'),
    capability: parseCapability(input['capability'], 'query.capability'),
    target: parseTarget(input['target'], 'query.target'),
    retrievalReason: stringValue(input['retrievalReason'], 'query.retrievalReason'),
    budget: parseBudget(input['budget'], 'query.budget'),
  };
}

function parseDiagnostic(value: unknown, label: string): ProviderDiagnostic {
  const input = record(value, label);
  onlyKeys(input, ['level', 'code', 'message'], label);
  return {
    level: enumValue(input['level'], new Set<ProviderDiagnostic['level']>(['info', 'warning', 'error']), `${label}.level`),
    code: identifier(input['code'], `${label}.code`),
    message: stringValue(input['message'], `${label}.message`),
  };
}

function parseFact(value: unknown, label: string): NormalizedGraphFact {
  const input = record(value, label);
  onlyKeys(input, ['version', 'kind', 'node', 'edge'], label);
  if (input['version'] !== CODE_INTELLIGENCE_CONTRACT_VERSION) {
    throw new Error(`${label}.version must be ${CODE_INTELLIGENCE_CONTRACT_VERSION}`);
  }
  if (input['kind'] === 'node') {
    if (input['edge'] !== undefined) throw new Error(`${label}.edge is not valid for a node fact`);
    return { version: CODE_INTELLIGENCE_CONTRACT_VERSION, kind: 'node', node: parseNode(input['node'], `${label}.node`) };
  }
  if (input['kind'] === 'edge') {
    if (input['node'] !== undefined) throw new Error(`${label}.node is not valid for an edge fact`);
    return { version: CODE_INTELLIGENCE_CONTRACT_VERSION, kind: 'edge', edge: parseEdge(input['edge'], `${label}.edge`) };
  }
  throw new Error(`${label}.kind must be node or edge`);
}

function factId(fact: NormalizedGraphFact): string {
  return `${fact.kind}:${fact.kind === 'node' ? fact.node.id : fact.edge.id}`;
}

export function parseCodeIntelligenceQueryResult(value: unknown): CodeIntelligenceQueryResult {
  const input = record(value, 'query result');
  onlyKeys(input, [
    'version', 'queryId', 'snapshotId', 'revision', 'provider', 'providerVersion', 'status',
    'facts', 'diagnostics', 'truncationReasons', 'observedDepth', 'observedMaxFanOut', 'bytes', 'durationMs',
  ], 'query result');
  if (input['version'] !== CODE_INTELLIGENCE_RESULT_VERSION) {
    throw new Error(`query result.version must be ${CODE_INTELLIGENCE_RESULT_VERSION}`);
  }
  const facts = arrayValue(input['facts'], 'query result.facts', MAX_FACTS)
    .map((item, index) => parseFact(item, `query result.facts[${index}]`));
  sortedUnique(facts.map(factId), 'query result.facts');
  const diagnostics = arrayValue(input['diagnostics'], 'query result.diagnostics', MAX_DIAGNOSTICS)
    .map((item, index) => parseDiagnostic(item, `query result.diagnostics[${index}]`));
  const truncationReasons = arrayValue(input['truncationReasons'], 'query result.truncationReasons', TRUNCATION_REASONS.size)
    .map((item, index) => enumValue(item, TRUNCATION_REASONS, `query result.truncationReasons[${index}]`));
  sortedUnique(truncationReasons, 'query result.truncationReasons');
  const status = enumValue(input['status'], QUERY_RESULT_STATUSES, 'query result.status');
  if (['empty', 'unsupported', 'unavailable', 'failed'].includes(status) && facts.length > 0) {
    throw new Error(`query result status ${status} cannot contain facts`);
  }
  if (status === 'truncated' && truncationReasons.length === 0) {
    throw new Error('truncated query results require at least one truncation reason');
  }
  if (status === 'complete' && truncationReasons.length > 0) {
    throw new Error('complete query results cannot have truncation reasons');
  }
  return {
    version: CODE_INTELLIGENCE_RESULT_VERSION,
    queryId: identifier(input['queryId'], 'query result.queryId'),
    snapshotId: identifier(input['snapshotId'], 'query result.snapshotId'),
    revision: revision(input['revision'], 'query result.revision'),
    provider: identifier(input['provider'], 'query result.provider'),
    providerVersion: stringValue(input['providerVersion'], 'query result.providerVersion', 256),
    status,
    facts,
    diagnostics,
    truncationReasons,
    observedDepth: nonNegativeInteger(input['observedDepth'], 'query result.observedDepth'),
    observedMaxFanOut: nonNegativeInteger(input['observedMaxFanOut'], 'query result.observedMaxFanOut'),
    bytes: nonNegativeInteger(input['bytes'], 'query result.bytes'),
    durationMs: nonNegativeInteger(input['durationMs'], 'query result.durationMs'),
  };
}

function assertFactPayloadMatchesSnapshot(
  fact: NormalizedGraphFact,
  snapshotNodes: ReadonlyMap<string, GraphNode>,
  snapshotEdges: ReadonlyMap<string, GraphEdge>,
  label: string,
): void {
  if (fact.kind === 'node') {
    const source = snapshotNodes.get(fact.node.id);
    if (source === undefined) throw new Error(`${label} does not match a node in the snapshot`);
    const { provenance: sourceProvenance, ...sourcePayload } = source;
    const { provenance: factProvenance, ...factPayload } = fact.node;
    if (
      canonicalJson(sourcePayload) !== canonicalJson(factPayload) ||
      canonicalJson(sourceProvenance.source) !== canonicalJson(factProvenance.source)
    ) throw new Error(`${label} does not match a node in the snapshot`);
    return;
  }
  const source = snapshotEdges.get(fact.edge.id);
  if (source === undefined) throw new Error(`${label} does not match an edge in the snapshot`);
  const { provenance: sourceProvenance, ...sourcePayload } = source;
  const { provenance: factProvenance, ...factPayload } = fact.edge;
  if (
    canonicalJson(sourcePayload) !== canonicalJson(factPayload) ||
    canonicalJson(sourceProvenance.source) !== canonicalJson(factProvenance.source)
  ) throw new Error(`${label} does not match an edge in the snapshot`);
}

/** Validates result identity, provenance, capability, and every deterministic query budget. */
export function assertQueryResultMatches(
  query: CodeIntelligenceQuery,
  snapshot: CodeIntelligenceSnapshot,
  result: CodeIntelligenceQueryResult,
): void {
  if (query.snapshotId !== snapshot.id || query.revision !== snapshot.revision) {
    throw new Error('query identity does not match the selected snapshot');
  }
  const supportsCapability = snapshot.capabilities.includes(query.capability);
  if (!supportsCapability && result.status !== 'unsupported') {
    throw new Error('an absent snapshot capability must produce an unsupported result');
  }
  if (supportsCapability && result.status === 'unsupported') {
    throw new Error('a declared snapshot capability cannot produce an unsupported result');
  }
  if (
    result.queryId !== query.id ||
    result.snapshotId !== snapshot.id ||
    result.revision !== snapshot.revision ||
    result.provider !== snapshot.provider ||
    result.providerVersion !== snapshot.providerVersion
  ) throw new Error('query result identity does not match the query and snapshot');
  if (result.facts.length > query.budget.maxResults) throw new Error('query result exceeds maxResults');
  if (result.observedDepth > query.budget.maxDepth) throw new Error('query result exceeds maxDepth');
  if (result.observedMaxFanOut > query.budget.maxFanOut) throw new Error('query result exceeds maxFanOut');
  if (result.bytes > query.budget.maxBytes) throw new Error('query result exceeds maxBytes');
  if (byteLength(JSON.stringify(result.facts)) > query.budget.maxBytes) {
    throw new Error('normalized query facts exceed maxBytes');
  }
  if (result.durationMs > query.budget.maxDurationMs && result.status !== 'truncated' && result.status !== 'failed') {
    throw new Error('query result exceeded maxDurationMs without reporting truncation or failure');
  }
  const snapshotNodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const snapshotEdges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  for (const fact of result.facts) {
    const item = fact.kind === 'node' ? fact.node : fact.edge;
    assertFactIdentity(item.provenance, snapshot, `query fact ${factId(fact)}`);
    if (item.provenance.queryId !== query.id || item.provenance.retrievalReason !== query.retrievalReason) {
      throw new Error(`query fact ${factId(fact)} provenance does not match the query`);
    }
    assertFactPayloadMatchesSnapshot(fact, snapshotNodes, snapshotEdges, `query fact ${factId(fact)}`);
  }
}

/** Parses a complete recorded provider contract used by offline conformance tests. */
export function parseCodeIntelligenceRecording(value: unknown): CodeIntelligenceRecording {
  const input = record(value, 'recording');
  onlyKeys(input, ['version', 'descriptor', 'snapshot', 'queryResults'], 'recording');
  if (input['version'] !== CODE_INTELLIGENCE_RECORDING_VERSION) {
    throw new Error(`recording.version must be ${CODE_INTELLIGENCE_RECORDING_VERSION}`);
  }
  const descriptor = parseCodeIntelligenceProviderDescriptor(input['descriptor']);
  const snapshot = parseCodeIntelligenceSnapshot(input['snapshot']);
  const queryResults = arrayValue(input['queryResults'], 'recording.queryResults', MAX_FACTS)
    .map((item) => parseCodeIntelligenceQueryResult(item));
  sortedUnique(queryResults.map((item) => item.queryId), 'recording.queryResults');
  if (
    descriptor.id !== snapshot.provider ||
    descriptor.providerVersion !== snapshot.providerVersion ||
    descriptor.adapterVersion !== snapshot.adapterVersion ||
    descriptor.schemaVersion !== snapshot.schemaVersion
  ) throw new Error('recording descriptor does not match its snapshot identity');
  const declared = new Set(
    descriptor.capabilities
      .filter((item) => item.status === 'supported' || item.status === 'experimental')
      .map((item) => item.capability),
  );
  for (const capability of snapshot.capabilities) {
    if (!declared.has(capability)) throw new Error(`snapshot capability is not declared by provider: ${capability}`);
  }
  const snapshotNodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const snapshotEdges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  for (const result of queryResults) {
    if (
      result.snapshotId !== snapshot.id ||
      result.revision !== snapshot.revision ||
      result.provider !== snapshot.provider ||
      result.providerVersion !== snapshot.providerVersion
    ) throw new Error(`recorded query result ${result.queryId} does not match its snapshot`);
    for (const fact of result.facts) {
      const item = fact.kind === 'node' ? fact.node : fact.edge;
      assertFactIdentity(item.provenance, snapshot, `recorded query fact ${factId(fact)}`);
      if (item.provenance.queryId !== result.queryId) {
        throw new Error(`recorded query fact ${factId(fact)} does not match its enclosing query result`);
      }
      assertFactPayloadMatchesSnapshot(fact, snapshotNodes, snapshotEdges, `recorded query fact ${factId(fact)}`);
    }
  }
  return { version: CODE_INTELLIGENCE_RECORDING_VERSION, descriptor, snapshot, queryResults };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/** Digest-bound provider identity suitable for snapshot/cache compatibility checks. */
export function providerCompatibilityDigest(descriptor: CodeIntelligenceProviderDescriptor): string {
  const normalized = parseCodeIntelligenceProviderDescriptor(descriptor);
  return sha256({
    contractVersion: normalized.contractVersion,
    id: normalized.id,
    providerVersion: normalized.providerVersion,
    adapterVersion: normalized.adapterVersion,
    schemaVersion: normalized.schemaVersion,
    capabilities: normalized.capabilities,
    languages: normalized.languages,
    distribution: normalized.distribution,
  });
}

/** Digest-bound immutable snapshot identity; graph payload is deliberately excluded. */
export function snapshotCompatibilityDigest(snapshot: CodeIntelligenceSnapshot): string {
  const normalized = parseCodeIntelligenceSnapshot(snapshot);
  return sha256({
    version: normalized.version,
    contractVersion: normalized.contractVersion,
    id: normalized.id,
    repositoryId: normalized.repositoryId,
    revision: normalized.revision,
    sourceTreeDigest: normalized.sourceTreeDigest,
    provider: normalized.provider,
    providerVersion: normalized.providerVersion,
    adapterVersion: normalized.adapterVersion,
    schemaVersion: normalized.schemaVersion,
    configurationDigest: normalized.configurationDigest,
    capabilities: normalized.capabilities,
  });
}
