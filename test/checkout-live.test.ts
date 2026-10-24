import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheckoutBenchmark, runCheckoutBenchmarkSample } from '../src/benchmark/checkout-live.ts';
import type {
  CheckoutBenchmarkProfile,
  CheckoutBenchmarkRepository,
  CheckoutStrategy,
} from '../src/benchmark/checkout.ts';

const roots: string[] = [];
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Redline test',
  GIT_AUTHOR_EMAIL: 'redline@example.invalid',
  GIT_COMMITTER_NAME: 'Redline test',
  GIT_COMMITTER_EMAIL: 'redline@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'redline-checkout-live-test-'));
  roots.push(path);
  return path;
}

async function initializeRemote(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, 'init', '--bare', '--quiet');
  git(path, 'config', 'uploadpack.allowFilter', 'true');
  git(path, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
}

async function createMergeRepository(parent: string): Promise<CheckoutBenchmarkRepository> {
  const remote = join(parent, 'merge.git');
  const work = join(parent, 'merge-work');
  await initializeRemote(remote);
  await mkdir(work);
  git(work, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(work, 'shared.txt'), 'base\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '--quiet', '-b', 'feature');
  for (let index = 1; index <= 5; index += 1) {
    await writeFile(join(work, `feature-${index}.txt`), `feature ${index}\n`);
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', `feature ${index}`);
  }
  git(work, 'checkout', '--quiet', 'main');
  await writeFile(join(work, 'main.txt'), 'main\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'main');
  git(work, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'merge feature');
  const head = git(work, 'rev-parse', 'HEAD');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '--quiet', 'origin', 'main', 'feature');
  const url = pathToFileURL(remote).href;
  return {
    id: 'merge',
    label: 'Merge fixture',
    sizeClass: 'small',
    repository: 'fixture/merge',
    baseUrl: url,
    headUrl: url,
    base,
    head,
  };
}

async function createForcePushedFork(parent: string): Promise<CheckoutBenchmarkRepository> {
  const baseRemote = join(parent, 'base.git');
  const baseWork = join(parent, 'base-work');
  const forkRemote = join(parent, 'fork.git');
  const forkWork = join(parent, 'fork-work');
  await initializeRemote(baseRemote);
  await mkdir(baseWork);
  git(baseWork, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(baseWork, 'base.txt'), 'base\n');
  git(baseWork, 'add', '.');
  git(baseWork, 'commit', '--quiet', '-m', 'base');
  const base = git(baseWork, 'rev-parse', 'HEAD');
  git(baseWork, 'remote', 'add', 'origin', baseRemote);
  git(baseWork, 'push', '--quiet', 'origin', 'main');
  git(baseRemote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(parent, 'clone', '--quiet', '--bare', baseRemote, forkRemote);
  git(forkRemote, 'config', 'uploadpack.allowFilter', 'true');
  git(forkRemote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(parent, 'clone', '--quiet', forkRemote, forkWork);
  git(forkWork, 'checkout', '--quiet', '-b', 'feature');
  await writeFile(join(forkWork, 'feature.txt'), 'original head\n');
  git(forkWork, 'add', '.');
  git(forkWork, 'commit', '--quiet', '-m', 'original head');
  const head = git(forkWork, 'rev-parse', 'HEAD');
  git(forkWork, 'push', '--quiet', 'origin', 'HEAD:refs/pull/1/head', 'feature');
  git(forkWork, 'reset', '--quiet', '--hard', base);
  await writeFile(join(forkWork, 'replacement.txt'), 'replacement head\n');
  git(forkWork, 'add', '.');
  git(forkWork, 'commit', '--quiet', '-m', 'replacement head');
  git(forkWork, 'push', '--quiet', '--force', 'origin', 'feature');
  return {
    id: 'fork',
    label: 'Force-pushed fork fixture',
    sizeClass: 'small',
    repository: 'fixture/fork',
    baseUrl: pathToFileURL(baseRemote).href,
    headUrl: pathToFileURL(forkRemote).href,
    base,
    head,
  };
}

function profile(repository: CheckoutBenchmarkRepository): CheckoutBenchmarkProfile {
  return {
    version: 1,
    kind: 'checkout-benchmark-profile',
    repetitions: 5,
    commandTimeoutMs: 60_000,
    materiality: {
      minimumSavedMs: 30_000,
      minimumSavedPercent: 5,
      simplicityWindowPercent: 10,
    },
    strategies: ['full', 'shallow', 'partial'],
    repositories: [repository],
  };
}

async function assertEquivalent(repository: CheckoutBenchmarkRepository, parent: string): Promise<void> {
  const strategies: readonly CheckoutStrategy[] = ['full', 'shallow', 'partial'];
  const samples = [];
  for (const strategy of strategies) {
    const sampleRoot = join(parent, `sample-${repository.id}-${strategy}`);
    await mkdir(sampleRoot);
    samples.push(await runCheckoutBenchmarkSample(profile(repository), repository, strategy, 1, sampleRoot));
  }
  expect(samples.map((sample) => sample.digests)).toEqual([
    samples[0]?.digests,
    samples[0]?.digests,
    samples[0]?.digests,
  ]);
  expect(new Set(samples.map((sample) => sample.revListCount))).toEqual(new Set([samples[0]?.revListCount]));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('checkout benchmark strategy correctness', () => {
  it('preserves merge history and bundle bytes through shallow and blobless fetches', async () => {
    const parent = await root();
    await assertEquivalent(await createMergeRepository(parent), parent);
  }, 120_000);

  it('fetches an exact force-pushed head from a fork without branch trust', async () => {
    const parent = await root();
    await assertEquivalent(await createForcePushedFork(parent), parent);
  }, 120_000);

  it('preserves the primary sample failure while cleaning the workspace', async () => {
    const parent = await root();
    const repository = await createMergeRepository(parent);
    const invalid = { ...repository, head: 'f'.repeat(40) };
    await expect(runCheckoutBenchmark(profile(invalid), {
      outputDirectory: join(parent, 'output'),
      runUrl: 'https://github.com/fixture/repository/actions/runs/1',
    })).rejects.toThrow(/git exited/u);
  }, 120_000);
});
