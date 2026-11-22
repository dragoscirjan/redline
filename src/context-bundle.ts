/** Deterministic context bundle builder. Git execution belongs to the revision adapter. */
import { constants } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  DEFAULT_REVIEW_ELIGIBILITY_PATH,
  MAX_REVIEW_ELIGIBILITY_BYTES,
  decideReviewEligibility,
  parseReviewEligibilityPolicy,
  policyDigest,
  type ReviewEligibilityPolicy,
  type ReviewEligibilityPolicyMetadata,
} from './review-eligibility.ts';

export const MAX_CAPTURE_FILES = 20_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const LOCK_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock',
  'Podfile.lock', 'flake.lock', 'uv.lock', 'Pipfile.lock',
]);
const GENERATED_DIRECTORY_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', 'vendor', 'coverage',
]);

export interface BundleArguments {
  readonly base: string;
  readonly head: string;
  readonly output: string;
  readonly eligibilityPolicyFile: string | null;
  /** Trusted adapter-only override, never repository- or model-selected.
   * Unstaged comparisons use an index baseline but trust the resolved committed policy. */
  readonly policyBase?: string;
}

interface ManifestFile {
  readonly id: string;
  readonly status: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly similarity: number | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
  readonly diffFile: string;
  readonly baseFile: string | null;
  readonly reviewed: boolean;
  readonly exclusionReason: string | null;
}

function splitNul(value: Buffer): Buffer[] {
  const entries: Buffer[] = [];
  let start = 0;
  while (start < value.length) {
    const end = value.indexOf(0, start);
    if (end === -1) {
      entries.push(value.subarray(start));
      break;
    }
    if (end > start) entries.push(value.subarray(start, end));
    start = end + 1;
  }
  return entries;
}

function decodePath(value: Buffer): string {
  try {
    return UTF8.decode(value);
  } catch {
    throw new Error('Git returned a path that is not valid UTF-8');
  }
}

function parseNumber(value: Buffer, label: string): number | null {
  const text = value.toString('ascii');
  if (text === '-') return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) throw new Error(`${label} is invalid`);
  const result = Number(text);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe integer range`);
  return result;
}

function parseNumstat(value: Buffer): { additions: number | null; deletions: number | null; path: Buffer } {
  const first = value.indexOf(9);
  const second = first === -1 ? -1 : value.indexOf(9, first + 1);
  if (first === -1 || second === -1) throw new Error('Malformed NUL-delimited numstat data');
  return {
    additions: parseNumber(value.subarray(0, first), 'numstat additions'),
    deletions: parseNumber(value.subarray(first + 1, second), 'numstat deletions'),
    path: value.subarray(second + 1),
  };
}

interface LoadedEligibilityPolicy {
  readonly policy: ReviewEligibilityPolicy | undefined;
  readonly metadata: ReviewEligibilityPolicyMetadata;
}

async function parsePolicyFile(path: string): Promise<{ readonly raw: string; readonly policy: ReviewEligibilityPolicy }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) {
    throw new Error('trusted review eligibility policy must be a regular file, not a symlink');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error('trusted review eligibility policy must be a regular file, not a symlink');
    }
    if (info.size > MAX_REVIEW_ELIGIBILITY_BYTES) {
      throw new Error('review eligibility policy exceeds its byte limit');
    }
    const raw = await handle.readFile({ encoding: 'utf8' });
    return { raw, policy: parseReviewEligibilityPolicy(raw) };
  } finally {
    await handle.close();
  }
}

async function loadEligibilityPolicy(
  git: BundleGit,
  base: string,
  trustedPolicyFile: string | null,
): Promise<LoadedEligibilityPolicy> {
  if (trustedPolicyFile !== null) {
    const loaded = await parsePolicyFile(trustedPolicyFile);
    return {
      policy: loaded.policy,
      metadata: {
        version: 1,
        source: 'trusted-workflow',
        path: null,
        digest: policyDigest(loaded.raw),
        includeRules: loaded.policy.include.length,
        excludeRules: loaded.policy.exclude.length,
      },
    };
  }

  const entries = UTF8.decode(await git.run(
    ['ls-tree', '-z', base, '--', DEFAULT_REVIEW_ELIGIBILITY_PATH],
  )).split('\0').filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return {
      policy: undefined,
      metadata: {
        version: 1,
        source: 'built-in',
        path: null,
        digest: null,
        includeRules: 0,
        excludeRules: 0,
      },
    };
  }
  const match = entries.length === 1
    ? /^(100644|100755) blob [0-9a-f]+\t(.+)$/u.exec(entries[0] as string)
    : null;
  if (match === null || match[2] !== DEFAULT_REVIEW_ELIGIBILITY_PATH) {
    throw new Error('trusted base review eligibility policy must be one regular file');
  }
  const raw = UTF8.decode(await git.run(['show', `${base}:${DEFAULT_REVIEW_ELIGIBILITY_PATH}`]));
  const policy = parseReviewEligibilityPolicy(raw);
  return {
    policy,
    metadata: {
      version: 1,
      source: 'trusted-base',
      path: DEFAULT_REVIEW_ELIGIBILITY_PATH,
      digest: policyDigest(raw),
      includeRules: policy.include.length,
      excludeRules: policy.exclude.length,
    },
  };
}

function reviewedFile(
  binary: boolean,
  paths: readonly (string | null)[],
  policy: ReviewEligibilityPolicy | undefined,
): { readonly reviewed: boolean; readonly reason: string | null } {
  if (binary) return { reviewed: false, reason: 'binary diff; not reviewable as text' };
  const candidates = paths.filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    const segments = candidate.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    if (LOCK_FILES.has(segments.at(-1)!)) return { reviewed: false, reason: 'lock file' };
    if (segments.slice(0, -1).some((segment) => GENERATED_DIRECTORY_NAMES.has(segment))) {
      return { reviewed: false, reason: 'generated or vendored directory' };
    }
  }
  return decideReviewEligibility(candidates, policy);
}

async function buildManifest(
  git: BundleGit,
  base: string,
  head: string,
  output: string,
  policy: ReviewEligibilityPolicy | undefined,
): Promise<ManifestFile[]> {
  const nameStatus = splitNul(await readFile(join(output, 'raw/name-status.z')));
  // Count changes, including deletions, before requesting any per-file artifacts.
  let changedFiles = 0;
  for (let index = 0; index < nameStatus.length;) {
    const status = nameStatus[index++]!.toString('ascii');
    index += status[0] === 'R' || status[0] === 'C' ? 2 : 1;
    if (index > nameStatus.length) throw new Error('Truncated name-status record');
    if (++changedFiles > MAX_CAPTURE_FILES) throw new Error('bundle exceeded its file count limit');
  }
  const numstat = splitNul(await readFile(join(output, 'raw/numstat.z')));
  const files: ManifestFile[] = [];
  let nameIndex = 0;
  let numstatIndex = 0;

  while (nameIndex < nameStatus.length) {
    const statusText = nameStatus[nameIndex++]!.toString('ascii');
    if (!/^(?:[RC][0-9]+|[AMDTUXB])$/u.test(statusText)) throw new Error('Unsupported name-status record');
    const status = statusText[0]!;
    const similarity = status === 'R' || status === 'C' ? Number(statusText.slice(1)) : null;
    let oldPath: string;
    let newPath: string;
    if (status === 'R' || status === 'C') {
      const oldRaw = nameStatus[nameIndex++];
      const newRaw = nameStatus[nameIndex++];
      if (oldRaw === undefined || newRaw === undefined) throw new Error('Truncated rename/copy record');
      oldPath = decodePath(oldRaw);
      newPath = decodePath(newRaw);
    } else {
      const path = nameStatus[nameIndex++];
      if (path === undefined) throw new Error('Truncated file path record');
      oldPath = decodePath(path);
      newPath = oldPath;
    }

    const statsRaw = numstat[numstatIndex++];
    if (statsRaw === undefined) throw new Error('Missing numstat record');
    const stats = parseNumstat(statsRaw);
    const binary = stats.additions === null || stats.deletions === null;
    if (stats.path.length === 0) {
      const oldRaw = numstat[numstatIndex++];
      const newRaw = numstat[numstatIndex++];
      if (oldRaw === undefined || newRaw === undefined) throw new Error('Truncated rename numstat record');
      oldPath = decodePath(oldRaw);
      newPath = decodePath(newRaw);
    } else if (status !== 'R' && status !== 'C') {
      oldPath = decodePath(stats.path);
      newPath = oldPath;
    }

    const id = String(files.length + 1).padStart(6, '0');
    const diffFile = `diffs/${id}.diff`;
    const diffPaths = status === 'D' ? [oldPath] : [...new Set([oldPath, newPath])].sort();
    await git.write(['diff', '--no-ext-diff', '--find-renames', '--binary', base, head, '--', ...diffPaths], join(output, diffFile));

    const eligibility = reviewedFile(binary, [oldPath, newPath], policy);
    let baseFile: string | null = null;
    if (status === 'D' || status === 'R' || (eligibility.reviewed && status !== 'A')) {
      const entry = UTF8.decode(await git.run(['ls-tree', '-z', base, '--', oldPath]));
      const metadata = /^(100644|100755|120000|160000) (blob|commit) [0-9a-f]{40,64}\t([\s\S]+)\0$/u.exec(entry);
      if (metadata === null || metadata[3] !== oldPath
        || metadata[2] !== (metadata[1] === '160000' ? 'commit' : 'blob')) {
        throw new Error('required base entry is missing or unsupported');
      }
      // Gitlinks are not source files; required blob read failures must propagate.
      if (metadata[1] !== '160000') {
        baseFile = `base-files/${id}`;
        await git.write(['show', `${base}:${oldPath}`], join(output, baseFile));
      }
    }

    files.push({
      id,
      status,
      oldPath: status === 'D' || status === 'R' || status === 'C' ? oldPath : null,
      newPath: status === 'D' ? null : newPath,
      similarity,
      additions: stats.additions,
      deletions: stats.deletions,
      binary,
      diffFile,
      baseFile,
      reviewed: eligibility.reviewed,
      exclusionReason: eligibility.reason,
    });
  }
  if (numstatIndex !== numstat.length) throw new Error('Unmatched numstat records');
  return files;
}

export interface BundleGit {
  run(args: readonly string[]): Promise<Buffer>;
  write(args: readonly string[], destination: string): Promise<void>;
}

/** Build authoritative artifacts through the revision adapter's bounded Git commands. */
export async function buildBundle(args: BundleArguments, git: BundleGit): Promise<void> {
  const base = UTF8.decode(await git.run(['rev-parse', '--verify', `${args.base}^{commit}`])).trim();
  const head = UTF8.decode(await git.run(['rev-parse', '--verify', `${args.head}^{commit}`])).trim();
  await git.run(['cat-file', '-e', `${base}^{commit}`]);
  await git.run(['cat-file', '-e', `${head}^{commit}`]);

  await Promise.all([
    mkdir(join(args.output, 'raw'), { recursive: true }),
    mkdir(join(args.output, 'diffs'), { recursive: true }),
    mkdir(join(args.output, 'base-files'), { recursive: true }),
    mkdir(join(args.output, 'commits'), { recursive: true }),
    mkdir(join(args.output, 'test-results'), { recursive: true }),
  ]);

  await writeFile(join(args.output, 'revisions.txt'), `base=${base}\nhead=${head}\n`);
  await git.write(['diff', '--name-status', '-z', '--find-renames', base, head], join(args.output, 'raw/name-status.z'));
  await git.write(['diff', '--numstat', '-z', '--find-renames', base, head], join(args.output, 'raw/numstat.z'));
  await git.write(['diff', '--stat', '--find-renames', base, head], join(args.output, 'summary.txt'));
  await git.write(['log', '--reverse', '--format=fuller', `${base}..${head}`], join(args.output, 'commits.txt'));
  const commitIds = join(args.output, 'raw/commit-ids.txt');
  await git.write(['rev-list', '--reverse', `${base}..${head}`], commitIds);
  if ((await stat(commitIds)).size === 0) {
    await git.write(['rev-parse', head], commitIds);
  }

  const eligibility = await loadEligibilityPolicy(git, args.policyBase ?? base, args.eligibilityPolicyFile);
  const files = await buildManifest(git, base, head, args.output, eligibility.policy);
  await writeFile(
    join(args.output, 'manifest.json'),
    `${JSON.stringify({ version: 2, base, head, eligibility: eligibility.metadata, files }, null, 2)}\n`,
  );

  const commits = UTF8.decode(await readFile(commitIds)).split('\n').filter((commit) => commit.length > 0);
  for (const commit of commits) {
    await git.write(['show', '--format=fuller', '--find-renames', '--binary', commit], join(args.output, `commits/${commit}.patch`));
  }

  await writeFile(join(args.output, 'README.md'), `# Pull request review bundle

Review the final base-to-head change. Commit history describes intent; the source checkout at HEAD provides file context. The reviewed flag and exclusionReason in manifest.json are precomputed deterministically from built-in rules plus an optional strict policy loaded from the trusted base revision or trusted workflow input. Pull-request head content cannot change its own eligibility.

Base: ${base}
Head: ${head}

manifest.json is the authoritative changed-file checklist. Each file has a numbered patch under diffs/. Reviewed non-added files have their base content under base-files/; deleted and renamed paths remain captured. Binary patches are stored as bytes and marked in the manifest. No pull request scripts or builds are run while preparing this bundle.
`);
}
