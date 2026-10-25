import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildCheckoutBenchmarkAggregate,
  checkoutProfileDigest,
  parseCheckoutBenchmarkAggregate,
  parseCheckoutBenchmarkProfile,
  pendingCheckoutBenchmarkAggregate,
  renderCheckoutBenchmarkReport,
  validateCheckoutBenchmarkAggregate,
  type CheckoutBenchmarkCapture,
  type CheckoutBenchmarkProfile,
  type CheckoutBenchmarkSample,
  type CheckoutStrategy,
} from '../src/benchmark/checkout.ts';

async function profile(): Promise<CheckoutBenchmarkProfile> {
  return parseCheckoutBenchmarkProfile(JSON.parse(await readFile('benchmark/checkout/v1/profile.json', 'utf8')) as unknown);
}

const DIGESTS = {
  bundle: 'a'.repeat(64),
  reviewSource: 'e'.repeat(64),
  baseSource: 'b'.repeat(64),
  headSource: 'c'.repeat(64),
  revList: 'd'.repeat(64),
};

function sample(
  repositoryId: string,
  strategy: CheckoutStrategy,
  repetition: number,
  criticalPathMs: number,
  digests = DIGESTS,
): CheckoutBenchmarkSample {
  return {
    repositoryId,
    strategy,
    repetition,
    checkoutMs: Math.floor(criticalPathMs * 0.4),
    fetchMs: Math.floor(criticalPathMs * 0.1),
    bundleColdMs: Math.floor(criticalPathMs * 0.25),
    bundleWarmMs: Math.floor(criticalPathMs * 0.2),
    indexSourceColdMs: criticalPathMs - Math.floor(criticalPathMs * 0.75),
    indexSourceWarmMs: Math.floor(criticalPathMs * 0.2),
    objectHydrationMs: Math.floor(criticalPathMs * 0.1),
    criticalPathMs,
    objectBytes: {
      afterCheckout: 100,
      addedByFetch: 20,
      addedByBundle: 10,
      addedByIndexSource: 30,
      final: 160,
    },
    digests,
    revListCount: 3,
  };
}

function capture(profileValue: CheckoutBenchmarkProfile, mismatch = false): CheckoutBenchmarkCapture {
  const samples: CheckoutBenchmarkSample[] = [];
  for (const repository of profileValue.repositories) {
    for (const strategy of profileValue.strategies) {
      for (let repetition = 1; repetition <= profileValue.repetitions; repetition += 1) {
        const large = repository.sizeClass === 'large';
        const duration = large
          ? strategy === 'full' ? 100_000 : strategy === 'shallow' ? 60_000 : 55_000
          : strategy === 'full' ? 10_000 : strategy === 'shallow' ? 8_000 : 9_000;
        const digests = mismatch && repository.sizeClass === 'large' && strategy === 'partial'
          ? { ...DIGESTS, bundle: 'f'.repeat(64) }
          : DIGESTS;
        samples.push(sample(repository.id, strategy, repetition, duration, digests));
      }
    }
  }
  return {
    version: 1,
    kind: 'checkout-benchmark-capture',
    profileDigest: checkoutProfileDigest(profileValue),
    capturedAt: '2026-10-25T00:00:00.000Z',
    runUrl: 'https://github.com/dragoscirjan/redline/actions/runs/1',
    environment: {
      runnerOs: 'Linux',
      architecture: 'x64',
      gitVersion: 'git version 2.51.0',
      nodeVersion: 'v24.10.0',
    },
    samples,
  };
}

describe('checkout benchmark report', () => {
  it('renders a strict pending aggregate before live evidence exists', async () => {
    const profileValue = await profile();
    const aggregate = pendingCheckoutBenchmarkAggregate(profileValue);
    expect(parseCheckoutBenchmarkAggregate(JSON.parse(JSON.stringify(aggregate)) as unknown)).toEqual(aggregate);
    expect(renderCheckoutBenchmarkReport(aggregate)).toContain('Live evidence pending');
    expect(aggregate.decision.status).toBe('pending');
  });

  it('selects the simplest correct strategy within ten percent of fastest', async () => {
    const profileValue = await profile();
    const aggregate = buildCheckoutBenchmarkAggregate(profileValue, capture(profileValue));
    expect(aggregate.status).toBe('complete');
    expect(aggregate.decision).toMatchObject({
      status: 'candidate-shallow',
      selectedStrategy: 'shallow',
      fastestStrategy: 'partial',
      savedMs: 40_000,
      savedPercent: 40,
      material: true,
      cacheEvaluation: 'eligible',
      rejectedStrategies: [],
    });
    expect(renderCheckoutBenchmarkReport(aggregate)).toContain('| vscode-large | shallow | yes |');
  });

  it('rejects aggregate identities or sample counts outside the pinned profile', async () => {
    const profileValue = await profile();
    const aggregate = buildCheckoutBenchmarkAggregate(profileValue, capture(profileValue));
    const malformed = {
      ...aggregate,
      strategies: aggregate.strategies.map((entry, index) => index === 0
        ? { ...entry, checkoutMs: { ...entry.checkoutMs, samples: 4 } }
        : entry),
    };
    expect(() => validateCheckoutBenchmarkAggregate(profileValue, malformed)).toThrow(/sample count/u);
  });

  it('rejects an incorrect alternative without invalidating correct candidates', async () => {
    const profileValue = await profile();
    const aggregate = buildCheckoutBenchmarkAggregate(profileValue, capture(profileValue, true));
    expect(aggregate.status).toBe('complete');
    expect(aggregate.decision).toMatchObject({
      status: 'candidate-shallow',
      selectedStrategy: 'shallow',
      rejectedStrategies: ['partial'],
    });
    expect(aggregate.strategies.find((entry) => entry.repositoryId === 'vscode-large' && entry.strategy === 'partial')?.equivalent).toBe(false);
  });

  it('invalidates evidence when repeated full samples are not equivalent', async () => {
    const profileValue = await profile();
    const valid = capture(profileValue);
    const samples = valid.samples.map((entry) =>
      entry.repositoryId === 'vscode-large' && entry.strategy === 'full' && entry.repetition === 5
        ? { ...entry, digests: { ...entry.digests, bundle: 'f'.repeat(64) } }
        : entry);
    const aggregate = buildCheckoutBenchmarkAggregate(profileValue, { ...valid, samples });
    expect(aggregate.status).toBe('invalid');
    expect(aggregate.decision.status).toBe('invalid');
    expect(aggregate.decision.rejectedStrategies).toContain('full');
  });

  it('rejects a repository URL that does not match the declared repository', async () => {
    const raw = JSON.parse(await readFile('benchmark/checkout/v1/profile.json', 'utf8')) as Record<string, unknown>;
    const repositories = raw['repositories'] as Record<string, unknown>[];
    repositories[0] = { ...repositories[0], baseUrl: 'https://github.com/example/other.git' };
    expect(() => parseCheckoutBenchmarkProfile(raw)).toThrow(/HTTPS GitHub URL/u);
  });
});
