import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import {
  loadCodeContextArtifact,
  type CodeContextArtifact,
  type CodeContextDiagnostic,
  type CodeContextProvider,
  type CodeContextStatus,
  type CodeContextTimings,
  type RelatedCodeSpan,
} from '../code-context/artifact.ts';
import { checkedFile, type ReviewBundle, type ReviewManifestFile } from './bundle.ts';
import type {
  GraphReference,
  ReviewCodeContextCacheStatus,
  ReviewCodeContextCoverage,
  ReviewCodeContextReason,
  ReviewCodeContextRunCoverage,
} from './types.ts';

export const MAX_INDEXED_CONTEXT_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_INDEXED_CONTEXT_SOURCE_BYTES = 48 * 1024;
export const MAX_INDEXED_CONTEXT_SOURCE_BYTES_PER_FILE = 24 * 1024;

export interface ReviewCodeContextInput {
  readonly path: string;
  readonly repository: string;
}

export interface ResolvedRelatedCodeSpan extends RelatedCodeSpan {
  readonly provider: CodeContextProvider;
  readonly revision: string;
  readonly status: 'complete' | 'partial';
  readonly content: string;
}

type ResolvedRelatedCodeSpanSource = Omit<ResolvedRelatedCodeSpan, 'status'>;

export interface PromptCodeContext {
  readonly status: 'complete' | 'partial';
  readonly related: readonly ResolvedRelatedCodeSpan[];
  readonly limitation: string;
}

interface ResolvedFileCodeContext {
  readonly coverage: ReviewCodeContextCoverage;
  readonly prompt: PromptCodeContext | undefined;
}

export interface LoadedReviewCodeContext {
  readonly coverage: ReviewCodeContextRunCoverage;
  readonly files: ReadonlyMap<string, ResolvedFileCodeContext>;
  readonly diagnostics: readonly CodeContextDiagnostic[];
  readonly timings: CodeContextTimings | null;
  readonly graphSnapshotRevision: string | null;
  readonly graphFactDigests: ReadonlySet<GraphReference['graphFactDigest']>;
}

export interface FileReviewCodeContext {
  readonly coverage: ReviewCodeContextCoverage;
  readonly prompt: PromptCodeContext | undefined;
}

const NO_RELATIONSHIP_NOTICE =
  'Indexed context is bounded and may be incomplete. Missing related spans do not prove that no relationship exists.';

function coverage(
  status: ReviewCodeContextCoverage['status'],
  provider: CodeContextProvider | null,
  revision: string | null,
  relatedSpans: number,
  sourceBytes: number,
  reason: ReviewCodeContextReason | null,
): ReviewCodeContextCoverage {
  return { status, provider, revision, relatedSpans, sourceBytes, reason };
}

function emptyLoaded(
  status: ReviewCodeContextRunCoverage['status'],
  reason: ReviewCodeContextReason,
  provider: CodeContextProvider | null = null,
  revision: string | null = null,
): LoadedReviewCodeContext {
  return {
    coverage: {
      ...coverage(status, provider, revision, 0, 0, reason),
      filesWithContext: 0,
      cache: status === 'disabled' ? 'not-applicable' : 'unavailable',
      timings: null,
      diagnosticCodes: [],
    },
    files: new Map(),
    diagnostics: [],
    timings: null,
    graphSnapshotRevision: null,
    graphFactDigests: new Set(),
  };
}

function artifactStatusReason(status: CodeContextStatus): ReviewCodeContextReason | null {
  if (status === 'partial') return 'provider-partial';
  if (status === 'unsupported') return 'artifact-unsupported';
  if (status === 'unavailable') return 'artifact-unavailable';
  return null;
}

function cacheStatus(artifact: CodeContextArtifact): ReviewCodeContextCacheStatus {
  if (artifact.status === 'unavailable') return 'unavailable';
  const codes = new Set(artifact.diagnostics.map((item) => item.code));
  if (codes.has('cache-base-revision')) return 'restored';
  if (codes.has('cold-index-skipped')) return 'skipped';
  if (artifact.status === 'unsupported') return 'unavailable';
  if (artifact.timings.indexMs > 0) return 'built';
  return 'unknown';
}

function reviewPaths(file: ReviewManifestFile): readonly string[] {
  const paths = [file.newPath, file.oldPath].filter((path): path is string => path !== null);
  return [...new Set(paths)];
}

function sourceLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

async function resolveSpan(
  bundle: ReviewBundle,
  artifact: CodeContextArtifact,
  span: RelatedCodeSpan,
): Promise<{ span: ResolvedRelatedCodeSpanSource; sourceBytes: number }> {
  const path = await checkedFile(
    bundle.sourceRoot,
    span.path,
    MAX_INDEXED_CONTEXT_SOURCE_FILE_BYTES,
    `indexed context source ${span.path}`,
  );
  const bytes = await readFile(path);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`indexed context source ${span.path} is not valid UTF-8`);
  }
  const lines = sourceLines(text);
  if (span.endLine > lines.length) {
    throw new Error(`indexed context span for ${span.path} exceeds captured head source`);
  }
  const content = lines.slice(span.startLine - 1, span.endLine).join('\n');
  return {
    span: {
      ...span,
      provider: artifact.provider,
      revision: artifact.revision,
      content,
    },
    sourceBytes: Buffer.byteLength(content, 'utf8'),
  };
}

function allowedChangedPaths(bundle: ReviewBundle): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of bundle.manifest.files) {
    for (const path of reviewPaths(file)) paths.add(path);
  }
  return paths;
}

function reviewedPathOwners(bundle: ReviewBundle): ReadonlyMap<string, number> {
  const owners = new Map<string, number>();
  let owner = 0;
  for (const file of bundle.manifest.files) {
    if (!file.reviewed || file.binary) continue;
    for (const path of reviewPaths(file)) owners.set(path, owner);
    owner += 1;
  }
  return owners;
}

function aggregateStatus(statuses: readonly CodeContextStatus[], fallback: CodeContextStatus): CodeContextStatus {
  if (statuses.length === 0) return fallback;
  const unique = new Set(statuses);
  if (unique.size === 1 && unique.has('complete')) return 'complete';
  if (unique.size === 1 && unique.has('unsupported')) return 'unsupported';
  if (unique.size === 1 && unique.has('unavailable')) return 'unavailable';
  return 'partial';
}

async function resolveArtifact(
  bundle: ReviewBundle,
  artifact: CodeContextArtifact,
): Promise<LoadedReviewCodeContext> {
  const allowedPaths = allowedChangedPaths(bundle);
  for (const file of artifact.files) {
    if (!allowedPaths.has(file.changedPath)) {
      throw new Error(`code-context changed path is not present in the review bundle: ${file.changedPath}`);
    }
    if ((file.status === 'unsupported' || file.status === 'unavailable') && file.related.length > 0) {
      throw new Error(`code-context ${file.changedPath} has related spans without coverage`);
    }
  }

  const pathOwners = reviewedPathOwners(bundle);
  const reviewedFileCount = new Set(pathOwners.values()).size;
  const seenOwners = new Set<number>();
  const selectedStatuses: CodeContextStatus[] = [];
  const files = new Map<string, ResolvedFileCodeContext>();
  let totalSourceBytes = 0;
  let totalRelatedSpans = 0;
  let filesWithContext = 0;
  let anyByteLimit = false;
  const graphFactDigests = new Set<GraphReference['graphFactDigest']>();

  for (const file of artifact.files) {
    const owner = pathOwners.get(file.changedPath);
    if (owner === undefined) continue;
    if (seenOwners.has(owner)) {
      throw new Error(`code-context repeats a reviewed file through path ${file.changedPath}`);
    }
    seenOwners.add(owner);
    selectedStatuses.push(file.status);

    const related: ResolvedRelatedCodeSpanSource[] = [];
    let fileSourceBytes = 0;
    let fileByteLimit = false;
    for (const candidate of file.related) {
      const resolved = await resolveSpan(bundle, artifact, candidate);
      if (
        fileSourceBytes + resolved.sourceBytes > MAX_INDEXED_CONTEXT_SOURCE_BYTES_PER_FILE
        || totalSourceBytes + resolved.sourceBytes > MAX_INDEXED_CONTEXT_SOURCE_BYTES
      ) {
        fileByteLimit = true;
        anyByteLimit = true;
        continue;
      }
      related.push(resolved.span);
      if (candidate.graphReference !== undefined) {
        graphFactDigests.add(candidate.graphReference.graphFactDigest);
      }
      fileSourceBytes += resolved.sourceBytes;
      totalSourceBytes += resolved.sourceBytes;
      totalRelatedSpans += 1;
    }

    const status = fileByteLimit ? 'partial' : file.status;
    const promptRelated = status === 'complete' || status === 'partial'
      ? related.map((span): ResolvedRelatedCodeSpan => ({ ...span, status }))
      : [];
    const reason = fileByteLimit ? 'source-byte-limit' : artifactStatusReason(status);
    const fileCoverage = coverage(
      status,
      artifact.provider,
      artifact.revision,
      related.length,
      fileSourceBytes,
      reason,
    );
    if (related.length > 0) filesWithContext += 1;
    files.set(file.changedPath, {
      coverage: fileCoverage,
      prompt: promptRelated.length > 0 && (status === 'complete' || status === 'partial')
        ? { status, related: promptRelated, limitation: NO_RELATIONSHIP_NOTICE }
        : undefined,
    });
  }

  const missingFileEntry = seenOwners.size < reviewedFileCount;
  const selectedStatus = aggregateStatus(selectedStatuses, artifact.status);
  const status = artifact.status === 'unsupported' || artifact.status === 'unavailable'
    ? artifact.status
    : anyByteLimit || missingFileEntry
      ? 'partial'
      : selectedStatus;
  const reason = anyByteLimit
    ? 'source-byte-limit'
    : missingFileEntry
      ? 'no-file-entry'
      : artifactStatusReason(status);
  return {
    coverage: {
      ...coverage(
        status,
        artifact.provider,
        artifact.revision,
        totalRelatedSpans,
        totalSourceBytes,
        reason,
      ),
      filesWithContext,
      cache: cacheStatus(artifact),
      timings: artifact.timings,
      diagnosticCodes: artifact.diagnostics.map((item) => item.code),
    },
    files,
    diagnostics: artifact.diagnostics,
    timings: artifact.timings,
    graphSnapshotRevision: artifact.baseRevision ?? null,
    graphFactDigests,
  };
}

/**
 * Loads optional indexed context. Any invalid, stale, or unreadable artifact
 * degrades to explicit unavailable coverage; it never blocks file-only review.
 */
export async function loadReviewCodeContext(
  bundle: ReviewBundle,
  input: ReviewCodeContextInput | undefined,
): Promise<LoadedReviewCodeContext> {
  if (input === undefined) return emptyLoaded('disabled', 'not-configured');

  let artifact: CodeContextArtifact;
  try {
    artifact = await loadCodeContextArtifact(input.path);
  } catch {
    return emptyLoaded('unavailable', 'artifact-invalid');
  }
  if (
    artifact.repository !== input.repository
    || artifact.revision !== bundle.manifest.head
    || (artifact.baseRevision !== undefined && artifact.baseRevision !== bundle.manifest.base)
  ) {
    return emptyLoaded('unavailable', 'identity-mismatch', artifact.provider, artifact.revision);
  }

  try {
    return await resolveArtifact(bundle, artifact);
  } catch {
    return emptyLoaded('unavailable', 'artifact-invalid', artifact.provider, artifact.revision);
  }
}

/** Returns deterministic coverage and prompt context for one manifest file. */
export function codeContextForFile(
  loaded: LoadedReviewCodeContext,
  file: ReviewManifestFile,
): FileReviewCodeContext {
  for (const path of reviewPaths(file)) {
    const resolved = loaded.files.get(path);
    if (resolved !== undefined) return resolved;
  }

  if (loaded.coverage.status === 'disabled') {
    return { coverage: coverage('disabled', null, null, 0, 0, 'not-configured'), prompt: undefined };
  }
  if (loaded.coverage.status === 'unsupported') {
    return {
      coverage: coverage(
        'unsupported',
        loaded.coverage.provider,
        loaded.coverage.revision,
        0,
        0,
        'artifact-unsupported',
      ),
      prompt: undefined,
    };
  }
  if (loaded.coverage.status === 'unavailable') {
    return {
      coverage: coverage(
        'unavailable',
        loaded.coverage.provider,
        loaded.coverage.revision,
        0,
        0,
        loaded.coverage.reason,
      ),
      prompt: undefined,
    };
  }
  return {
    coverage: coverage(
      'partial',
      loaded.coverage.provider,
      loaded.coverage.revision,
      0,
      0,
      'no-file-entry',
    ),
    prompt: undefined,
  };
}
