#!/usr/bin/env node
/** Builds the deterministic, untrusted-data-only pull request review bundle. */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import { pathToFileURL } from 'node:url';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const LOCK_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock',
  'Podfile.lock', 'flake.lock', 'uv.lock', 'Pipfile.lock',
]);
const GENERATED_DIRECTORY_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', 'vendor', 'coverage',
]);

interface Arguments {
  readonly base: string;
  readonly head: string;
  readonly output: string;
  readonly sourceDirectory: string | null;
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
}

class UsageError extends Error {}

function usage(program: string): string {
  return `Usage: ${program} --base <commit> --head <commit> --output <review-dir> [--source <source-dir>]`;
}

function parseArguments(values: readonly string[], program: string): Arguments {
  let base = '';
  let head = '';
  let output = '';
  let sourceDirectory: string | null = null;
  for (let index = 0; index < values.length;) {
    const key = values[index];
    const value = values[index + 1];
    if (value === undefined) throw new UsageError(usage(program));
    if (key === '--base') base = value;
    else if (key === '--head') head = value;
    else if (key === '--output') output = value;
    else if (key === '--source') sourceDirectory = value;
    else throw new UsageError(usage(program));
    index += 2;
  }
  if (base.length === 0 || head.length === 0 || output.length === 0) {
    throw new UsageError(usage(program));
  }
  return { base, head, output, sourceDirectory };
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number }, maximum: number): void {
  state.bytes += chunk.length;
  if (state.bytes > maximum) throw new Error('subprocess output exceeded its byte limit');
  chunks.push(chunk);
}

async function waitForProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly stdout?: Writable } = {},
): Promise<{ readonly status: number; readonly stdout: Buffer; readonly stderr: string }> {
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  let overflow: Error | undefined;
  let outputError: Error | undefined;
  options.stdout?.once('error', (error: Error) => {
    outputError = error;
    child.kill('SIGKILL');
  });
  child.stdout.on('data', (value: Buffer) => {
    if (overflow !== undefined) return;
    try {
      if (options.stdout === undefined) appendBounded(stdoutChunks, value, stdoutState, MAX_CAPTURE_BYTES);
      else if (!options.stdout.write(value)) child.stdout.pause();
    } catch (error) {
      overflow = error instanceof Error ? error : new Error(String(error));
      child.kill('SIGKILL');
    }
  });
  if (options.stdout !== undefined) {
    options.stdout.on('drain', () => child.stdout.resume());
  }
  child.stderr.on('data', (value: Buffer) => {
    if (overflow !== undefined) return;
    try {
      appendBounded(stderrChunks, value, stderrState, MAX_DIAGNOSTIC_BYTES);
    } catch (error) {
      overflow = error instanceof Error ? error : new Error(String(error));
      child.kill('SIGKILL');
    }
  });
  const status = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal !== null) reject(new Error(`${command} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (overflow !== undefined) throw overflow;
  if (outputError !== undefined) throw outputError;
  return {
    status,
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
  };
}

async function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<Buffer> {
  const result = await waitForProcess(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed with exit code ${result.status}${
      result.stderr.length === 0 ? '' : `: ${result.stderr}`}`);
  }
  return result.stdout;
}

async function runToFile(
  command: string,
  args: readonly string[],
  destination: string,
  allowFailure = false,
): Promise<boolean> {
  await mkdir(dirname(destination), { recursive: true });
  const output = createWriteStream(destination, { flags: 'w' });
  try {
    const result = await waitForProcess(command, args, { stdout: output });
    output.end();
    await finished(output);
    if (result.status !== 0 && !allowFailure) {
      throw new Error(`${command} ${args[0] ?? ''} failed with exit code ${result.status}${
        result.stderr.length === 0 ? '' : `: ${result.stderr}`}`);
    }
    return result.status === 0;
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function runGit(repo: string, args: readonly string[]): Promise<Buffer> {
  return run('git', ['-C', repo, ...args]);
}

async function runGitToFile(
  repo: string,
  args: readonly string[],
  destination: string,
  allowFailure = false,
): Promise<boolean> {
  return runToFile('git', ['-C', repo, ...args], destination, allowFailure);
}

async function extractSource(repo: string, head: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const archive = spawn('git', ['-C', repo, 'archive', head], { stdio: ['ignore', 'pipe', 'pipe'] });
  const extractor = spawn('tar', ['-x', '-C', destination], { stdio: ['pipe', 'ignore', 'pipe'] });
  archive.stdout.pipe(extractor.stdin);

  const collect = async (child: ChildProcess, name: string): Promise<void> => {
    if (child.stderr === null) throw new Error(`${name} has no diagnostic stream`);
    const stderrChunks: Buffer[] = [];
    const state = { bytes: 0 };
    let overflow: Error | undefined;
    child.stderr.on('data', (value: Buffer) => {
      if (overflow !== undefined) return;
      try {
        appendBounded(stderrChunks, value, state, MAX_DIAGNOSTIC_BYTES);
      } catch (error) {
        overflow = error instanceof Error ? error : new Error(String(error));
        child.kill('SIGKILL');
      }
    });
    const status = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal !== null) reject(new Error(`${name} terminated by ${signal}`));
        else resolve(code ?? 1);
      });
    });
    if (overflow !== undefined) throw overflow;
    if (status !== 0) {
      const diagnostic = Buffer.concat(stderrChunks).toString('utf8').trim();
      throw new Error(`${name} failed with exit code ${status}${diagnostic.length === 0 ? '' : `: ${diagnostic}`}`);
    }
  };

  await Promise.all([collect(archive, 'git archive'), collect(extractor, 'tar')]);
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

function reviewedFile(binary: boolean, paths: readonly (string | null)[]): boolean {
  if (binary) return false;
  for (const candidate of paths) {
    if (candidate === null) continue;
    const segments = candidate.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    if (LOCK_FILES.has(segments.at(-1)!)) return false;
    if (segments.slice(0, -1).some((segment) => GENERATED_DIRECTORY_NAMES.has(segment))) return false;
  }
  return true;
}

async function buildManifest(repo: string, base: string, head: string, output: string): Promise<ManifestFile[]> {
  const nameStatus = splitNul(await readFile(join(output, 'raw/name-status.z')));
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
    await runGitToFile(repo, ['diff', '--no-ext-diff', '--find-renames', '--binary', base, head, '--', ...diffPaths], join(output, diffFile));

    const reviewed = reviewedFile(binary, [oldPath, newPath]);
    let baseFile: string | null = null;
    if (status === 'D' || status === 'R' || (reviewed && status !== 'A')) {
      baseFile = `base-files/${id}`;
      const path = join(output, baseFile);
      if (!await runGitToFile(repo, ['show', `${base}:${oldPath}`], path, true)) {
        await rm(path, { force: true });
        baseFile = null;
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
      reviewed,
    });
  }
  if (numstatIndex !== numstat.length) throw new Error('Unmatched numstat records');
  return files;
}

async function buildBundle(args: Arguments, cwd: string): Promise<void> {
  const repo = UTF8.decode(await run('git', ['rev-parse', '--show-toplevel'], { cwd })).trim();
  const base = UTF8.decode(await runGit(repo, ['rev-parse', '--verify', `${args.base}^{commit}`])).trim();
  const head = UTF8.decode(await runGit(repo, ['rev-parse', '--verify', `${args.head}^{commit}`])).trim();
  await runGit(repo, ['cat-file', '-e', `${base}^{commit}`]);
  await runGit(repo, ['cat-file', '-e', `${head}^{commit}`]);

  await Promise.all([
    mkdir(join(args.output, 'raw'), { recursive: true }),
    mkdir(join(args.output, 'diffs'), { recursive: true }),
    mkdir(join(args.output, 'base-files'), { recursive: true }),
    mkdir(join(args.output, 'commits'), { recursive: true }),
    mkdir(join(args.output, 'test-results'), { recursive: true }),
  ]);
  if (args.sourceDirectory !== null) await extractSource(repo, head, args.sourceDirectory);

  await writeFile(join(args.output, 'revisions.txt'), `base=${base}\nhead=${head}\n`);
  await runGitToFile(repo, ['diff', '--name-status', '-z', '--find-renames', base, head], join(args.output, 'raw/name-status.z'));
  await runGitToFile(repo, ['diff', '--numstat', '-z', '--find-renames', base, head], join(args.output, 'raw/numstat.z'));
  await runGitToFile(repo, ['diff', '--stat', '--find-renames', base, head], join(args.output, 'summary.txt'));
  await runGitToFile(repo, ['log', '--reverse', '--format=fuller', `${base}..${head}`], join(args.output, 'commits.txt'));
  const commitIds = join(args.output, 'raw/commit-ids.txt');
  await runGitToFile(repo, ['rev-list', '--reverse', `${base}..${head}`], commitIds);
  if ((await stat(commitIds)).size === 0) {
    await runGitToFile(repo, ['rev-parse', head], commitIds);
  }

  const files = await buildManifest(repo, base, head, args.output);
  await writeFile(join(args.output, 'manifest.json'), `${JSON.stringify({ version: 1, base, head, files }, null, 2)}\n`);

  const commits = UTF8.decode(await readFile(commitIds)).split('\n').filter((commit) => commit.length > 0);
  for (const commit of commits) {
    await runGitToFile(repo, ['show', '--format=fuller', '--find-renames', '--binary', commit], join(args.output, `commits/${commit}.patch`));
  }

  await writeFile(join(args.output, 'README.md'), `# Pull request review bundle

Review the final base-to-head change. Commit history describes intent; the source checkout at HEAD provides file context. The reviewed flag in manifest.json is precomputed deterministically: lock files, vendored dependencies, build output, and binary files are excluded from review.

Base: ${base}
Head: ${head}

manifest.json is the authoritative changed-file checklist. Each file has a numbered patch under diffs/. Reviewed non-added files have their base content under base-files/; deleted and renamed paths remain captured. Binary patches are stored as bytes and marked in the manifest. No pull request scripts or builds are run while preparing this bundle.
`);
}

export async function main(
  values: readonly string[] = process.argv.slice(2),
  cwd = process.cwd(),
  program = process.argv[1] ?? 'context-bundle',
): Promise<number> {
  try {
    await buildBundle(parseArguments(values, program), cwd);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`redline-context-bundle: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await main();
