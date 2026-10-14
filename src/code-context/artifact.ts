import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

export const CODE_CONTEXT_VERSION = 1 as const;
export const MAX_CODE_CONTEXT_ARTIFACT_BYTES = 128 * 1024;

const MAX_FILES = 256;
const MAX_CONTEXTS = 64;
const MAX_CONTEXTS_PER_FILE = 8;
const MAX_CONTEXT_LINES = 80;
const MAX_DIAGNOSTICS = 20;
const MAX_PATH_BYTES = 4_096;
const MAX_DIAGNOSTIC_BYTES = 512;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type CodeContextStatus = 'complete' | 'partial' | 'unsupported' | 'unavailable';
export type CodeContextDiagnosticLevel = 'info' | 'warning' | 'error';

export interface CodeContextProvider {
  id: string;
  version: string;
}

export interface CodeContextGraphReference {
  provider: string;
  providerVersion: string;
  snapshotRevision: string;
  capability: string;
  query: string;
  relationship: string;
  resolution: 'exact' | 'approximate' | 'unresolved';
  graphFactDigest: `sha256:${string}`;
}

export interface RelatedCodeSpan {
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  /** Action-produced identity for this exact provider fact, when available. */
  graphReference?: CodeContextGraphReference | undefined;
}

export interface ChangedFileCodeContext {
  changedPath: string;
  status: CodeContextStatus;
  related: RelatedCodeSpan[];
}

export interface CodeContextDiagnostic {
  level: CodeContextDiagnosticLevel;
  code: string;
  message: string;
}

export interface CodeContextTimings {
  installationMs: number;
  restoreMs: number;
  indexMs: number;
  queryMs: number;
  saveMs: number | null;
}

export interface CodeContextArtifact {
  version: typeof CODE_CONTEXT_VERSION;
  provider: CodeContextProvider;
  repository: string;
  revision: string;
  /** Exact provider graph snapshot. Legacy v1 artifacts may omit it. */
  baseRevision?: string | undefined;
  status: CodeContextStatus;
  files: ChangedFileCodeContext[];
  diagnostics: CodeContextDiagnostic[];
  timings: CodeContextTimings;
}

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

function boundedString(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (byteLength(value) > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  return value;
}

function repositoryPath(value: unknown, label: string): string {
  const parsed = boundedString(value, label, MAX_PATH_BYTES);
  const segments = parsed.split('/');
  if (
    parsed.startsWith('/')
    || parsed.includes('\\')
    || parsed.includes('\0')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) throw new Error(`${label} must be a normalized repository-relative path`);
  return parsed;
}

function commit(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  if (!COMMIT_PATTERN.test(parsed)) throw new Error(`${label} must be a full commit identifier`);
  return parsed;
}

export function codeContextGraphFactDigest(
  reference: Omit<CodeContextGraphReference, 'graphFactDigest'>,
): `sha256:${string}` {
  const canonical = JSON.stringify({
    provider: reference.provider,
    providerVersion: reference.providerVersion,
    snapshotRevision: reference.snapshotRevision,
    capability: reference.capability,
    query: reference.query,
    relationship: reference.relationship,
    resolution: reference.resolution,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function status(value: unknown, label: string): CodeContextStatus {
  if (value === 'complete' || value === 'partial' || value === 'unsupported' || value === 'unavailable') return value;
  throw new Error(`${label} is unsupported`);
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

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertStrictlySorted(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || compareUtf8(previous, current) >= 0) {
      throw new Error(`${label} must be sorted and unique`);
    }
  }
}

function parseGraphReference(value: unknown, label: string): CodeContextGraphReference {
  const input = record(value, label);
  onlyKeys(
    input,
    [
      'provider',
      'providerVersion',
      'snapshotRevision',
      'capability',
      'query',
      'relationship',
      'resolution',
      'graphFactDigest',
    ],
    label,
  );
  const resolution = input['resolution'];
  if (resolution !== 'exact' && resolution !== 'approximate' && resolution !== 'unresolved') {
    throw new Error(`${label}.resolution is unsupported`);
  }
  const digest = boundedString(input['graphFactDigest'], `${label}.graphFactDigest`, 71);
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${label}.graphFactDigest must be sha256`);
  const reference: CodeContextGraphReference = {
    provider: boundedString(input['provider'], `${label}.provider`, 64),
    providerVersion: boundedString(input['providerVersion'], `${label}.providerVersion`, 128),
    snapshotRevision: commit(input['snapshotRevision'], `${label}.snapshotRevision`),
    capability: boundedString(input['capability'], `${label}.capability`, 128),
    query: boundedString(input['query'], `${label}.query`, 2_048),
    relationship: boundedString(input['relationship'], `${label}.relationship`, 256),
    resolution,
    graphFactDigest: digest as `sha256:${string}`,
  };
  if (reference.graphFactDigest !== codeContextGraphFactDigest(reference)) {
    throw new Error(`${label}.graphFactDigest does not match the graph fact identity`);
  }
  return reference;
}

function parseRelatedSpan(value: unknown, label: string): RelatedCodeSpan {
  const input = record(value, label);
  onlyKeys(input, ['path', 'startLine', 'endLine', 'reason', 'graphReference'], label);
  const startLine = positiveInteger(input['startLine'], `${label}.startLine`);
  const endLine = positiveInteger(input['endLine'], `${label}.endLine`);
  if (endLine < startLine) throw new Error(`${label}.endLine must not precede startLine`);
  if (endLine - startLine + 1 > MAX_CONTEXT_LINES) throw new Error(`${label} exceeds the line limit`);
  const graphReference = input['graphReference'] === undefined
    ? undefined
    : parseGraphReference(input['graphReference'], `${label}.graphReference`);
  return {
    path: repositoryPath(input['path'], `${label}.path`),
    startLine,
    endLine,
    reason: boundedString(input['reason'], `${label}.reason`, 256),
    ...(graphReference === undefined ? {} : { graphReference }),
  };
}

function relatedIdentity(value: RelatedCodeSpan): string {
  return `${value.path}\0${String(value.startLine).padStart(16, '0')}\0${String(value.endLine).padStart(16, '0')}\0${value.reason}`;
}

function relatedSpanQuery(changedPath: string, span: RelatedCodeSpan): string {
  const endpoint = JSON.stringify([changedPath, span.path, span.startLine, span.endLine]);
  return `related-span:sha256:${createHash('sha256').update(endpoint, 'utf8').digest('hex')}`;
}

function parseFile(value: unknown, label: string): ChangedFileCodeContext {
  const input = record(value, label);
  onlyKeys(input, ['changedPath', 'status', 'related'], label);
  if (!Array.isArray(input['related'])) throw new Error(`${label}.related must be an array`);
  if (input['related'].length > MAX_CONTEXTS_PER_FILE) throw new Error(`${label}.related exceeds the per-file limit`);
  const changedPath = repositoryPath(input['changedPath'], `${label}.changedPath`);
  const related = input['related'].map((item, index) => parseRelatedSpan(item, `${label}.related[${index}]`));
  for (const [index, span] of related.entries()) {
    if (span.path === changedPath) throw new Error(`${label}.related[${index}].path must identify a different file`);
    if (
      span.graphReference !== undefined
      && (
        span.graphReference.query !== relatedSpanQuery(changedPath, span)
        || span.graphReference.relationship !== span.reason
        || span.graphReference.resolution !== 'exact'
      )
    ) {
      throw new Error(`${label}.related[${index}].graphReference does not identify the exact related span`);
    }
  }
  assertStrictlySorted(related.map(relatedIdentity), `${label}.related`);
  return { changedPath, status: status(input['status'], `${label}.status`), related };
}

function parseDiagnostic(value: unknown, label: string): CodeContextDiagnostic {
  const input = record(value, label);
  onlyKeys(input, ['level', 'code', 'message'], label);
  const level = input['level'];
  if (level !== 'info' && level !== 'warning' && level !== 'error') throw new Error(`${label}.level is unsupported`);
  const code = boundedString(input['code'], `${label}.code`, 64);
  if (!IDENTIFIER_PATTERN.test(code)) throw new Error(`${label}.code is invalid`);
  return {
    level,
    code,
    message: boundedString(input['message'], `${label}.message`, MAX_DIAGNOSTIC_BYTES),
  };
}

function parseTimings(value: unknown): CodeContextTimings {
  const input = record(value, 'code-context.timings');
  onlyKeys(input, ['installationMs', 'restoreMs', 'indexMs', 'queryMs', 'saveMs'], 'code-context.timings');
  const saveMs = input['saveMs'];
  return {
    installationMs: nonNegativeInteger(input['installationMs'], 'code-context.timings.installationMs'),
    restoreMs: nonNegativeInteger(input['restoreMs'], 'code-context.timings.restoreMs'),
    indexMs: nonNegativeInteger(input['indexMs'], 'code-context.timings.indexMs'),
    queryMs: nonNegativeInteger(input['queryMs'], 'code-context.timings.queryMs'),
    saveMs: saveMs === null ? null : nonNegativeInteger(saveMs, 'code-context.timings.saveMs'),
  };
}

function expectedAggregateStatus(files: readonly ChangedFileCodeContext[]): CodeContextStatus {
  const statuses = new Set(files.map((file) => file.status));
  if (statuses.size === 0 || (statuses.size === 1 && statuses.has('unsupported'))) return 'unsupported';
  if (statuses.size === 1 && statuses.has('complete')) return 'complete';
  if (statuses.has('complete') || statuses.has('partial') || statuses.size > 1) return 'partial';
  return 'unavailable';
}

/** Strictly parses the compact provider-neutral artifact emitted by github/code-index. */
export function parseCodeContextArtifact(value: unknown): CodeContextArtifact {
  const input = record(value, 'code-context');
  onlyKeys(input, ['version', 'provider', 'repository', 'revision', 'baseRevision', 'status', 'files', 'diagnostics', 'timings'], 'code-context');
  if (input['version'] !== CODE_CONTEXT_VERSION) throw new Error(`code-context.version must be ${CODE_CONTEXT_VERSION}`);

  const provider = record(input['provider'], 'code-context.provider');
  onlyKeys(provider, ['id', 'version'], 'code-context.provider');
  const providerId = boundedString(provider['id'], 'code-context.provider.id', 64);
  if (!IDENTIFIER_PATTERN.test(providerId)) throw new Error('code-context.provider.id is invalid');
  const providerVersion = boundedString(provider['version'], 'code-context.provider.version', 128);
  const repository = boundedString(input['repository'], 'code-context.repository', 512);
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('code-context.repository must use owner/name form');
  const revision = commit(input['revision'], 'code-context.revision');
  const baseRevision = input['baseRevision'] === undefined
    ? undefined
    : commit(input['baseRevision'], 'code-context.baseRevision');

  if (!Array.isArray(input['files'])) throw new Error('code-context.files must be an array');
  if (input['files'].length > MAX_FILES) throw new Error('code-context.files exceeds the file limit');
  const files = input['files'].map((item, index) => parseFile(item, `code-context.files[${index}]`));
  assertStrictlySorted(files.map((file) => file.changedPath), 'code-context.files');
  const contextCount = files.reduce((count, file) => count + file.related.length, 0);
  if (contextCount > MAX_CONTEXTS) throw new Error('code-context related spans exceed the artifact limit');
  for (const file of files) {
    for (const span of file.related) {
      const reference = span.graphReference;
      if (reference === undefined) continue;
      if (
        baseRevision === undefined
        || reference.provider !== providerId
        || reference.providerVersion !== providerVersion
        || reference.snapshotRevision !== baseRevision
        || reference.capability !== 'related-spans'
      ) {
        throw new Error('code-context graph reference does not match its provider base snapshot');
      }
    }
  }

  if (!Array.isArray(input['diagnostics'])) throw new Error('code-context.diagnostics must be an array');
  if (input['diagnostics'].length > MAX_DIAGNOSTICS) throw new Error('code-context.diagnostics exceeds the limit');
  const diagnostics = input['diagnostics'].map((item, index) => parseDiagnostic(item, `code-context.diagnostics[${index}]`));

  const artifactStatus = status(input['status'], 'code-context.status');
  const aggregateStatus = expectedAggregateStatus(files);
  if (files.length === 0) {
    if (artifactStatus !== 'unsupported' && artifactStatus !== 'unavailable') {
      throw new Error('code-context.status does not match empty coverage');
    }
  } else if (artifactStatus !== aggregateStatus && artifactStatus !== 'partial') {
    throw new Error('code-context.status does not match per-file coverage');
  }

  return {
    version: CODE_CONTEXT_VERSION,
    provider: { id: providerId, version: providerVersion },
    repository,
    revision,
    ...(baseRevision === undefined ? {} : { baseRevision }),
    status: artifactStatus,
    files,
    diagnostics,
    timings: parseTimings(input['timings']),
  };
}

/** Loads a bounded regular JSON file and applies the exact artifact schema. */
export async function loadCodeContextArtifact(path: string): Promise<CodeContextArtifact> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('code-context artifact must be a regular file, not a symlink');
  if (info.size > MAX_CODE_CONTEXT_ARTIFACT_BYTES) throw new Error('code-context artifact exceeds the byte limit');
  const raw = await readFile(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('code-context artifact must contain valid JSON');
  }
  return parseCodeContextArtifact(value);
}
