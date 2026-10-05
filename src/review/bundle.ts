/**
 * Loads and validates the review context bundle produced by
 * `context-bundle.sh`.
 *
 * The bundle is untrusted data: every file is size-bounded, path-checked
 * against the bundle root, and rejected when it is a symlink or escapes
 * the trusted root. The manifest schema is exact — unknown fields are
 * rejected rather than ignored.
 */

import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const REVIEW_BUNDLE_VERSION = 1 as const;

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_REVISIONS_BYTES = 1024;
const MAX_REVIEW_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_REVIEW_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_FILES = 2_000;
const MAX_REPOSITORY_PATH_BYTES = 4_096;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const FILE_ID_PATTERN = /^\d{6}$/u;
const FILE_STATUSES = new Set(['A', 'M', 'D', 'R', 'C', 'T', 'U', 'X', 'B']);

export interface ReviewManifestFile {
  id: string;
  status: string;
  oldPath: string | null;
  newPath: string | null;
  similarity: number | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** false marks files excluded from review by the bundle (generated, lock files). */
  reviewed: boolean;
  diffFile: string;
  baseFile: string | null;
}

export interface ReviewManifest {
  version: typeof REVIEW_BUNDLE_VERSION;
  base: string;
  head: string;
  files: ReviewManifestFile[];
}

export interface ReviewBundle {
  root: string;
  sourceRoot: string;
  manifestPath: string;
  revisionsPath: string;
  instructionsPath: string | undefined;
  requirementsPath: string | undefined;
  summaryPath: string | undefined;
  commitsPath: string | undefined;
  manifest: ReviewManifest;
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${key} must be a non-empty string`);
  return value;
}

function nullableString(record: Record<string, unknown>, key: string, label: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${key} must be a string or null`);
  return value;
}

function nullableNonNegativeInteger(record: Record<string, unknown>, key: string, label: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label}.${key} must be a non-negative integer or null`);
  }
  return value as number;
}

function validateRepositoryPath(value: string | null, label: string): void {
  if (value === null) return;
  if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`);
  if (byteLength(value) > MAX_REPOSITORY_PATH_BYTES) throw new Error(`${label} exceeds the path byte limit`);
}

export function parseReviewManifest(value: unknown): ReviewManifest {
  if (!isRecord(value)) throw new Error('manifest.json must contain an object');
  assertOnlyKeys(value, ['version', 'base', 'head', 'files'], 'manifest');
  if (value.version !== REVIEW_BUNDLE_VERSION) throw new Error('manifest.json uses an unsupported version');

  const base = requiredString(value, 'base', 'manifest');
  const head = requiredString(value, 'head', 'manifest');
  if (!COMMIT_PATTERN.test(base) || !COMMIT_PATTERN.test(head)) {
    throw new Error('manifest.json base and head must be full commit identifiers');
  }
  if (!Array.isArray(value.files)) throw new Error('manifest.files must be an array');
  if (value.files.length > MAX_MANIFEST_FILES) throw new Error('manifest.files exceeds the file-count limit');

  const seenIds = new Set<string>();
  const files = value.files.map((item, index): ReviewManifestFile => {
    const label = `manifest.files[${index}]`;
    if (!isRecord(item)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(
      item,
      [
        'id',
        'status',
        'oldPath',
        'newPath',
        'similarity',
        'additions',
        'deletions',
        'binary',
        'diffFile',
        'baseFile',
        'reviewed',
      ],
      label,
    );
    const id = requiredString(item, 'id', label);
    if (!FILE_ID_PATTERN.test(id) || seenIds.has(id)) throw new Error(`${label}.id must be a unique six-digit value`);
    seenIds.add(id);

    const status = requiredString(item, 'status', label);
    if (!FILE_STATUSES.has(status)) throw new Error(`${label}.status is unsupported`);
    const oldPath = nullableString(item, 'oldPath', label);
    const newPath = nullableString(item, 'newPath', label);
    validateRepositoryPath(oldPath, `${label}.oldPath`);
    validateRepositoryPath(newPath, `${label}.newPath`);
    if (oldPath === null && newPath === null) throw new Error(`${label} must identify at least one repository path`);

    const similarity = nullableNonNegativeInteger(item, 'similarity', label);
    if (similarity !== null && similarity > 100) throw new Error(`${label}.similarity cannot exceed 100`);
    const additions = nullableNonNegativeInteger(item, 'additions', label);
    const deletions = nullableNonNegativeInteger(item, 'deletions', label);
    if (typeof item.binary !== 'boolean') throw new Error(`${label}.binary must be a boolean`);
    if (item.reviewed !== undefined && typeof item.reviewed !== 'boolean') {
      throw new Error(`${label}.reviewed must be a boolean when present`);
    }

    const diffFile = requiredString(item, 'diffFile', label);
    if (diffFile !== `diffs/${id}.diff`) throw new Error(`${label}.diffFile does not match its file id`);
    const baseFile = nullableString(item, 'baseFile', label);
    if (baseFile !== null && baseFile !== `base-files/${id}`) {
      throw new Error(`${label}.baseFile does not match its file id`);
    }

    return {
      id,
      status,
      oldPath,
      newPath,
      similarity,
      additions,
      deletions,
      binary: item.binary,
      reviewed: item.reviewed ?? true,
      diffFile,
      baseFile,
    };
  });

  return { version: REVIEW_BUNDLE_VERSION, base, head, files };
}

export async function checkedDirectory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory, not a symlink`);
  }
  return realpath(absolute);
}

export function ensureInside(root: string, candidate: string, label: string): void {
  const relation = relative(root, candidate);
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes its trusted root`);
  }
}

export async function checkedFile(root: string, relativePath: string, maxBytes: number, label: string): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error(`${label} has an invalid relative path`);
  const candidate = resolve(root, relativePath);
  ensureInside(root, candidate, label);
  const info = await lstat(candidate).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a symlink`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds its byte limit`);
  const canonical = await realpath(candidate);
  ensureInside(root, canonical, label);
  return canonical;
}

export async function optionalCheckedFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<string | undefined> {
  const candidate = resolve(root, relativePath);
  ensureInside(root, candidate, relativePath);
  const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return undefined;
  return checkedFile(root, relativePath, maxBytes, relativePath);
}

export async function readCheckedText(
  root: string,
  relativePath: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const path = await checkedFile(root, relativePath, maxBytes, label);
  const value = await readFile(path, 'utf8');
  if (byteLength(value) > maxBytes) throw new Error(`${label} exceeds its byte limit`);
  return value;
}

function parseRevisions(value: string): { base: string; head: string } {
  const entries = new Map<string, string>();
  for (const line of value.split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('revisions.txt is malformed');
    const key = line.slice(0, separator);
    const item = line.slice(separator + 1);
    if (entries.has(key)) throw new Error(`revisions.txt repeats ${key}`);
    entries.set(key, item);
  }
  if (entries.size !== 2 || !entries.has('base') || !entries.has('head')) {
    throw new Error('revisions.txt must contain only base and head');
  }
  const base = entries.get('base') as string;
  const head = entries.get('head') as string;
  if (!COMMIT_PATTERN.test(base) || !COMMIT_PATTERN.test(head)) {
    throw new Error('revisions.txt base and head must be full commit identifiers');
  }
  return { base, head };
}

export async function loadReviewBundle(reviewDirectory: string, sourceDirectory: string): Promise<ReviewBundle> {
  const root = await checkedDirectory(reviewDirectory, 'review directory');
  const sourceRoot = await checkedDirectory(sourceDirectory, 'source directory');
  const manifestPath = await checkedFile(root, 'manifest.json', MAX_MANIFEST_BYTES, 'manifest.json');
  const revisionsPath = await checkedFile(root, 'revisions.txt', MAX_REVISIONS_BYTES, 'revisions.txt');
  const manifestText = await readFile(manifestPath, 'utf8');
  if (byteLength(manifestText) > MAX_MANIFEST_BYTES) throw new Error('manifest.json exceeds its byte limit');

  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestText) as unknown;
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  const manifest = parseReviewManifest(decoded);
  const revisions = parseRevisions(await readFile(revisionsPath, 'utf8'));
  if (manifest.base !== revisions.base || manifest.head !== revisions.head) {
    throw new Error('manifest.json and revisions.txt disagree');
  }

  let totalDiffBytes = 0;
  for (const file of manifest.files) {
    const diffPath = await checkedFile(root, file.diffFile, MAX_REVIEW_DIFF_BYTES, file.diffFile);
    totalDiffBytes += (await lstat(diffPath)).size;
    if (totalDiffBytes > MAX_TOTAL_REVIEW_DIFF_BYTES) {
      throw new Error('review diffs exceed the total byte limit');
    }
    if (file.baseFile) await checkedFile(root, file.baseFile, Number.MAX_SAFE_INTEGER, file.baseFile);
  }

  return {
    root,
    sourceRoot,
    manifestPath,
    revisionsPath,
    instructionsPath: await optionalCheckedFile(root, 'README.md', 64 * 1024),
    requirementsPath: await optionalCheckedFile(root, 'requirements.md', 256 * 1024),
    summaryPath: await optionalCheckedFile(root, 'summary.txt', 256 * 1024),
    commitsPath: await optionalCheckedFile(root, 'commits.txt', 2 * 1024 * 1024),
    manifest,
  };
}
