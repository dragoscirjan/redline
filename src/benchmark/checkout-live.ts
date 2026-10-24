import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile,
} from 'node:fs/promises';
import { arch, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  buildCheckoutBenchmarkAggregate,
  CHECKOUT_BENCHMARK_VERSION,
  checkoutProfileDigest,
  type CheckoutBenchmarkCapture,
  type CheckoutBenchmarkProfile,
  type CheckoutBenchmarkRepository,
  type CheckoutBenchmarkSample,
  type CheckoutStrategy,
  writeCheckoutBenchmarkAggregate,
  writeCheckoutBenchmarkReport,
} from './checkout.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTEXT_BUNDLE = resolve(ROOT, 'src/context-bundle.ts');
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TREE_ENTRIES = 250_000;
const MAX_SHALLOW_DEPTH = 16_384;
const INDEX_METADATA = ['.codegraphcontext', '.gitnexus', '.cgcignore', '.gitnexusignore', '.gitnexusrc'] as const;

interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CheckoutBenchmarkRunOptions {
  readonly outputDirectory: string;
  readonly runUrl: string;
  readonly runnerOs?: string;
  readonly architecture?: string;
  readonly keepWorkspaces?: boolean;
  readonly progress?: (message: string) => void;
}

function bounded(value: Buffer): string {
  return value.subarray(Math.max(0, value.length - MAX_DIAGNOSTIC_BYTES)).toString('utf8')
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/gu, ' ');
}

function safeEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  allowFailure = false,
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    const capture = (chunks: Buffer[], value: Buffer, output: 'stdout' | 'stderr'): void => {
      const next = output === 'stdout' ? stdoutBytes + value.length : stderrBytes + value.length;
      if (output === 'stdout') stdoutBytes = next;
      else stderrBytes = next;
      if (next <= MAX_COMMAND_OUTPUT_BYTES) chunks.push(value);
      else exceeded = true;
    };
    child.stdout.on('data', (value: Buffer) => capture(stdout, value, 'stdout'));
    child.stderr.on('data', (value: Buffer) => capture(stderr, value, 'stderr'));
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`${basename(command)} exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      if (exceeded) {
        rejectPromise(new Error(`${basename(command)} exceeded the ${MAX_COMMAND_OUTPUT_BYTES}-byte output bound`));
        return;
      }
      const result = {
        status: status ?? (signal === null ? 1 : 128),
        stdout: stdoutBuffer.toString('utf8'),
        stderr: stderrBuffer.toString('utf8'),
      };
      if (!allowFailure && result.status !== 0) {
        rejectPromise(new Error(`${basename(command)} exited ${result.status}: ${bounded(stderrBuffer)}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

async function runGit(
  repository: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  allowFailure = false,
): Promise<ProcessResult> {
  return runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false', ...args], repository, environment, timeoutMs, allowFailure);
}

async function elapsed(operation: () => Promise<void>): Promise<number> {
  const started = process.hrtime.bigint();
  await operation();
  return Number((process.hrtime.bigint() - started) / 1_000_000n);
}

async function objectBytes(path: string): Promise<number> {
  let total = 0;
  let entries = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) throw new Error('Git object store exceeds the benchmark entry bound');
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) total += (await stat(entryPath)).size;
    }
  };
  await visit(path);
  return total;
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', rejectPromise);
    stream.once('end', resolvePromise);
  });
  return hash.digest('hex');
}

export async function digestDirectory(root: string): Promise<string> {
  const hash = createHash('sha256');
  let entries = 0;
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) throw new Error('benchmark tree exceeds the entry bound');
      const childPath = join(directory, child.name);
      const path = relative(root, childPath).split('\\').join('/');
      const metadata = await lstat(childPath);
      if (metadata.isSymbolicLink()) throw new Error(`benchmark tree retained a symbolic link: ${path}`);
      if (metadata.isDirectory()) {
        hash.update(`directory\0${path}\0`);
        await visit(childPath);
      } else if (metadata.isFile()) {
        hash.update(`file\0${path}\0${metadata.mode & 0o111 ? 'x' : '-'}\0${metadata.size}\0${await digestFile(childPath)}\0`);
      } else {
        throw new Error(`benchmark tree contains an unsupported entry: ${path}`);
      }
    }
  };
  await visit(root);
  return hash.digest('hex');
}

async function removeSymbolicLinks(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const metadata = await lstat(entryPath);
      if (metadata.isSymbolicLink()) await unlink(entryPath);
      else if (metadata.isDirectory()) await visit(entryPath);
    }
  };
  await visit(root);
}

async function archiveRevision(
  repository: string,
  revision: string,
  destination: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const git = spawn('git', ['-c', 'core.hooksPath=/dev/null', 'archive', '--format=tar', revision], {
      cwd: repository,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tar = spawn('tar', ['-x', '-C', destination], {
      cwd: repository,
      env: environment,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const diagnostics: Buffer[] = [];
    let diagnosticBytes = 0;
    let gitStatus: number | null = null;
    let tarStatus: number | null = null;
    let settled = false;
    const capture = (value: Buffer): void => {
      diagnosticBytes += value.length;
      if (diagnosticBytes <= MAX_DIAGNOSTIC_BYTES) diagnostics.push(value);
    };
    git.stderr.on('data', capture);
    tar.stderr.on('data', capture);
    git.stdout.pipe(tar.stdin);
    const finish = (): void => {
      if (settled || gitStatus === null || tarStatus === null) return;
      settled = true;
      clearTimeout(timer);
      if (gitStatus !== 0 || tarStatus !== 0 || diagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
        rejectPromise(new Error(`git archive pipeline failed (${gitStatus}/${tarStatus}): ${bounded(Buffer.concat(diagnostics))}`));
      } else resolvePromise();
    };
    git.once('error', rejectPromise);
    tar.once('error', rejectPromise);
    git.once('close', (status) => {
      gitStatus = status ?? 1;
      finish();
    });
    tar.once('close', (status) => {
      tarStatus = status ?? 1;
      finish();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      git.kill('SIGKILL');
      tar.kill('SIGKILL');
      rejectPromise(new Error(`git archive pipeline exceeded ${timeoutMs} ms`));
    }, timeoutMs);
  });
  await removeSymbolicLinks(destination);
  for (const metadata of INDEX_METADATA) await rm(join(destination, metadata), { recursive: true, force: true });
}

async function configureRepository(
  repositoryPath: string,
  candidate: CheckoutBenchmarkRepository,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  strategy: CheckoutStrategy,
): Promise<void> {
  await runGit(repositoryPath, ['init', '--quiet', '--initial-branch=benchmark'], environment, timeoutMs);
  await runGit(repositoryPath, ['remote', 'add', 'base', candidate.baseUrl], environment, timeoutMs);
  if (candidate.headUrl !== candidate.baseUrl) {
    await runGit(repositoryPath, ['remote', 'add', 'head', candidate.headUrl], environment, timeoutMs);
  }
  if (strategy === 'partial') {
    await runGit(repositoryPath, ['config', 'extensions.partialClone', 'base'], environment, timeoutMs);
    for (const remote of candidate.headUrl === candidate.baseUrl ? ['base'] : ['base', 'head']) {
      await runGit(repositoryPath, ['config', `remote.${remote}.promisor`, 'true'], environment, timeoutMs);
      await runGit(repositoryPath, ['config', `remote.${remote}.partialclonefilter`, 'blob:none'], environment, timeoutMs);
    }
  }
}

async function fetchCommit(
  repositoryPath: string,
  remote: string,
  revision: string,
  flags: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  await runGit(repositoryPath, ['fetch', '--quiet', '--no-tags', ...flags, remote, revision], environment, timeoutMs);
}

async function isAncestor(
  repositoryPath: string,
  base: string,
  head: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  const result = await runGit(repositoryPath, ['merge-base', '--is-ancestor', base, head], environment, timeoutMs, true);
  if (result.status !== 0 && result.status !== 1) throw new Error(`git merge-base exited ${result.status}`);
  return result.status === 0;
}

async function shallowRangeComplete(
  repositoryPath: string,
  base: string,
  head: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  if (!await isAncestor(repositoryPath, base, head, environment, timeoutMs)) return false;
  let boundaries: readonly string[];
  try {
    boundaries = (await readFile(join(repositoryPath, '.git/shallow'), 'utf8'))
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (boundaries.length === 0) return true;
  const range = new Set((await runGit(
    repositoryPath, ['rev-list', `${base}..${head}`], environment, timeoutMs,
  )).stdout.trim().split('\n').filter((entry) => entry.length > 0));
  return boundaries.every((boundary) => !range.has(boundary));
}

async function initialCheckout(
  repositoryPath: string,
  candidate: CheckoutBenchmarkRepository,
  strategy: CheckoutStrategy,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  await configureRepository(repositoryPath, candidate, environment, timeoutMs, strategy);
  const flags = strategy === 'shallow'
    ? ['--depth=1']
    : strategy === 'partial' ? ['--filter=blob:none'] : [];
  await fetchCommit(repositoryPath, 'base', candidate.base, flags, environment, timeoutMs);
  await runGit(repositoryPath, ['checkout', '--quiet', '--detach', candidate.base], environment, timeoutMs);
}

async function exactFetch(
  repositoryPath: string,
  candidate: CheckoutBenchmarkRepository,
  strategy: CheckoutStrategy,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  const headRemote = candidate.headUrl === candidate.baseUrl ? 'base' : 'head';
  if (strategy === 'full') {
    await fetchCommit(repositoryPath, 'base', candidate.base, [], environment, timeoutMs);
    await fetchCommit(repositoryPath, headRemote, candidate.head, [], environment, timeoutMs);
    return;
  }
  if (strategy === 'partial') {
    await fetchCommit(repositoryPath, 'base', candidate.base, ['--filter=blob:none'], environment, timeoutMs);
    await fetchCommit(repositoryPath, headRemote, candidate.head, ['--filter=blob:none'], environment, timeoutMs);
    return;
  }
  await fetchCommit(repositoryPath, 'base', candidate.base, ['--depth=1'], environment, timeoutMs);
  await fetchCommit(repositoryPath, headRemote, candidate.head, ['--depth=1'], environment, timeoutMs);
  let deepen = 2;
  while (!await shallowRangeComplete(repositoryPath, candidate.base, candidate.head, environment, timeoutMs)) {
    if (deepen > MAX_SHALLOW_DEPTH) {
      await fetchCommit(repositoryPath, headRemote, candidate.head, ['--unshallow'], environment, timeoutMs);
      break;
    }
    await fetchCommit(repositoryPath, headRemote, candidate.head, [`--deepen=${deepen}`], environment, timeoutMs);
    deepen *= 2;
  }
  if (!await shallowRangeComplete(repositoryPath, candidate.base, candidate.head, environment, timeoutMs)) {
    throw new Error('shallow exact-revision fetch did not complete the base-to-head revision closure');
  }
}

async function buildBundle(
  repositoryPath: string,
  base: string,
  head: string,
  destination: string,
  sourceDestination: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  await runProcess(process.execPath, [
    CONTEXT_BUNDLE,
    '--base', base,
    '--head', head,
    '--output', destination,
    '--source', sourceDestination,
  ], repositoryPath, environment, timeoutMs);
}

async function sourceExports(
  repositoryPath: string,
  base: string,
  head: string,
  root: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  await archiveRevision(repositoryPath, base, join(root, 'base'), environment, timeoutMs);
  await archiveRevision(repositoryPath, head, join(root, 'head'), environment, timeoutMs);
}

function difference(after: number, before: number): number {
  return Math.max(0, after - before);
}

export async function runCheckoutBenchmarkSample(
  profile: CheckoutBenchmarkProfile,
  candidate: CheckoutBenchmarkRepository,
  strategy: CheckoutStrategy,
  repetition: number,
  sampleRoot: string,
): Promise<CheckoutBenchmarkSample> {
  const repositoryPath = join(sampleRoot, 'repository');
  const home = join(sampleRoot, 'home');
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(home, { recursive: true, mode: 0o700 });
  const environment = safeEnvironment(home);

  const checkoutMs = await elapsed(async () => initialCheckout(
    repositoryPath, candidate, strategy, environment, profile.commandTimeoutMs,
  ));
  const afterCheckout = await objectBytes(join(repositoryPath, '.git/objects'));
  const fetchMs = await elapsed(async () => exactFetch(
    repositoryPath, candidate, strategy, environment, profile.commandTimeoutMs,
  ));
  const afterFetch = await objectBytes(join(repositoryPath, '.git/objects'));

  const revisionList = (await runGit(
    repositoryPath, ['rev-list', '--reverse', `${candidate.base}..${candidate.head}`], environment, profile.commandTimeoutMs,
  )).stdout;
  const revListCount = revisionList.trim().length === 0 ? 0 : revisionList.trim().split('\n').length;
  const revListDigest = createHash('sha256').update(revisionList, 'utf8').digest('hex');

  const coldIndexSource = join(sampleRoot, 'index-source-cold');
  const warmIndexSource = join(sampleRoot, 'index-source-warm');
  const indexSourceColdMs = await elapsed(async () => sourceExports(
    repositoryPath, candidate.base, candidate.head, coldIndexSource, environment, profile.commandTimeoutMs,
  ));
  const afterIndexSource = await objectBytes(join(repositoryPath, '.git/objects'));
  const baseSourceDigest = await digestDirectory(join(coldIndexSource, 'base'));
  const headSourceDigest = await digestDirectory(join(coldIndexSource, 'head'));
  await rm(coldIndexSource, { recursive: true, force: true });
  const indexSourceWarmMs = await elapsed(async () => sourceExports(
    repositoryPath, candidate.base, candidate.head, warmIndexSource, environment, profile.commandTimeoutMs,
  ));
  if (baseSourceDigest !== await digestDirectory(join(warmIndexSource, 'base'))
    || headSourceDigest !== await digestDirectory(join(warmIndexSource, 'head'))) {
    throw new Error('cold and warm index source exports differ');
  }
  await rm(warmIndexSource, { recursive: true, force: true });

  const coldBundle = join(sampleRoot, 'bundle-cold');
  const coldReviewSource = join(sampleRoot, 'review-source-cold');
  const warmBundle = join(sampleRoot, 'bundle-warm');
  const warmReviewSource = join(sampleRoot, 'review-source-warm');
  const bundleColdMs = await elapsed(async () => buildBundle(
    repositoryPath, candidate.base, candidate.head, coldBundle, coldReviewSource, environment, profile.commandTimeoutMs,
  ));
  const afterBundle = await objectBytes(join(repositoryPath, '.git/objects'));
  const coldBundleDigest = await digestDirectory(coldBundle);
  const reviewSourceDigest = await digestDirectory(coldReviewSource);
  await rm(coldBundle, { recursive: true, force: true });
  await rm(coldReviewSource, { recursive: true, force: true });
  const bundleWarmMs = await elapsed(async () => buildBundle(
    repositoryPath, candidate.base, candidate.head, warmBundle, warmReviewSource, environment, profile.commandTimeoutMs,
  ));
  if (coldBundleDigest !== await digestDirectory(warmBundle)
    || reviewSourceDigest !== await digestDirectory(warmReviewSource)) {
    throw new Error('cold and warm context bundles differ');
  }
  await rm(warmBundle, { recursive: true, force: true });
  await rm(warmReviewSource, { recursive: true, force: true });

  const objectHydrationMs = Math.max(0, indexSourceColdMs - indexSourceWarmMs)
    + Math.max(0, bundleColdMs - bundleWarmMs);
  return {
    repositoryId: candidate.id,
    strategy,
    repetition,
    checkoutMs,
    fetchMs,
    bundleColdMs,
    bundleWarmMs,
    indexSourceColdMs,
    indexSourceWarmMs,
    objectHydrationMs,
    criticalPathMs: checkoutMs + fetchMs + bundleColdMs + indexSourceColdMs,
    objectBytes: {
      afterCheckout,
      addedByFetch: difference(afterFetch, afterCheckout),
      addedByIndexSource: difference(afterIndexSource, afterFetch),
      addedByBundle: difference(afterBundle, afterIndexSource),
      final: afterBundle,
    },
    digests: {
      bundle: coldBundleDigest,
      reviewSource: reviewSourceDigest,
      baseSource: baseSourceDigest,
      headSource: headSourceDigest,
      revList: revListDigest,
    },
    revListCount,
  };
}

function orderedRuns(profile: CheckoutBenchmarkProfile): readonly {
  readonly repository: CheckoutBenchmarkRepository;
  readonly strategy: CheckoutStrategy;
  readonly repetition: number;
}[] {
  const runs: { repository: CheckoutBenchmarkRepository; strategy: CheckoutStrategy; repetition: number }[] = [];
  for (let repetition = 1; repetition <= profile.repetitions; repetition += 1) {
    const repositories = repetition % 2 === 0 ? [...profile.repositories].reverse() : [...profile.repositories];
    const offset = (repetition - 1) % profile.strategies.length;
    const strategies = [...profile.strategies.slice(offset), ...profile.strategies.slice(0, offset)];
    for (const repositoryEntry of repositories) {
      for (const strategy of strategies) runs.push({ repository: repositoryEntry, strategy, repetition });
    }
  }
  return runs;
}

export async function runCheckoutBenchmark(
  profile: CheckoutBenchmarkProfile,
  options: CheckoutBenchmarkRunOptions,
): Promise<CheckoutBenchmarkCapture> {
  const outputDirectory = resolve(options.outputDirectory);
  const rawDirectory = join(outputDirectory, 'raw');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(rawDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
  const samples: CheckoutBenchmarkSample[] = [];
  const progress = options.progress ?? (() => undefined);
  const workspaceParent = await mkdtemp(join(tmpdir(), 'redline-checkout-benchmark-'));
  try {
    for (const run of orderedRuns(profile)) {
      const identity = `${run.repository.id}/${run.strategy}/${run.repetition}`;
      progress(`checkout benchmark start ${identity}`);
      const sampleRoot = join(workspaceParent, `${run.repository.id}-${run.strategy}-${run.repetition}`);
      await mkdir(sampleRoot, { recursive: true });
      try {
        const sample = await runCheckoutBenchmarkSample(
          profile, run.repository, run.strategy, run.repetition, sampleRoot,
        );
        samples.push(sample);
        await writeFile(join(rawDirectory, `${run.repository.id}-${run.strategy}-${run.repetition}.json`), `${JSON.stringify(sample, null, 2)}\n`);
        progress(`checkout benchmark complete ${identity}`);
      } finally {
        if (options.keepWorkspaces !== true) await rm(sampleRoot, { recursive: true, force: true });
      }
    }
  } finally {
    if (options.keepWorkspaces !== true) await rm(workspaceParent, { recursive: true, force: true });
  }
  const gitVersion = (await runProcess('git', ['--version'], ROOT, safeEnvironment(join(outputDirectory, '.home')), profile.commandTimeoutMs)).stdout.trim();
  const capture: CheckoutBenchmarkCapture = {
    version: CHECKOUT_BENCHMARK_VERSION,
    kind: 'checkout-benchmark-capture',
    profileDigest: checkoutProfileDigest(profile),
    capturedAt: new Date().toISOString(),
    runUrl: options.runUrl,
    environment: {
      runnerOs: options.runnerOs ?? process.platform,
      architecture: options.architecture ?? arch(),
      gitVersion,
      nodeVersion: process.version,
    },
    samples,
  };
  await writeFile(join(outputDirectory, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`);
  const aggregate = buildCheckoutBenchmarkAggregate(profile, capture);
  await writeCheckoutBenchmarkAggregate(join(outputDirectory, 'aggregate.json'), aggregate);
  await writeCheckoutBenchmarkReport(join(outputDirectory, 'report.md'), aggregate);
  return capture;
}

export async function readLocalProfileForTests(path: string): Promise<CheckoutBenchmarkProfile> {
  return JSON.parse(await readFile(path, 'utf8')) as CheckoutBenchmarkProfile;
}
