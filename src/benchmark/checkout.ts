import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';

export const CHECKOUT_BENCHMARK_VERSION = 1 as const;
export const CHECKOUT_STRATEGIES = ['full', 'shallow', 'partial'] as const;
export type CheckoutStrategy = typeof CHECKOUT_STRATEGIES[number];

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const HTTPS_GITHUB_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/u;
const MAX_REPOSITORIES = 4;
const MAX_SAMPLES = 120;

export interface CheckoutMaterialityPolicy {
  readonly minimumSavedMs: number;
  readonly minimumSavedPercent: number;
  readonly simplicityWindowPercent: number;
}

export interface CheckoutBenchmarkRepository {
  readonly id: string;
  readonly label: string;
  readonly sizeClass: 'small' | 'large';
  readonly repository: string;
  readonly baseUrl: string;
  readonly headUrl: string;
  readonly base: string;
  readonly head: string;
}

export interface CheckoutBenchmarkProfile {
  readonly version: typeof CHECKOUT_BENCHMARK_VERSION;
  readonly kind: 'checkout-benchmark-profile';
  readonly repetitions: number;
  readonly commandTimeoutMs: number;
  readonly materiality: CheckoutMaterialityPolicy;
  readonly strategies: readonly CheckoutStrategy[];
  readonly repositories: readonly CheckoutBenchmarkRepository[];
}

export interface CheckoutObjectBytes {
  readonly afterCheckout: number;
  readonly addedByFetch: number;
  readonly addedByIndexSource: number;
  readonly addedByBundle: number;
  readonly final: number;
}

export interface CheckoutDigests {
  readonly bundle: string;
  readonly reviewSource: string;
  readonly baseSource: string;
  readonly headSource: string;
  readonly revList: string;
}

export interface CheckoutBenchmarkSample {
  readonly repositoryId: string;
  readonly strategy: CheckoutStrategy;
  readonly repetition: number;
  readonly checkoutMs: number;
  readonly fetchMs: number;
  readonly bundleColdMs: number;
  readonly bundleWarmMs: number;
  readonly indexSourceColdMs: number;
  readonly indexSourceWarmMs: number;
  readonly objectHydrationMs: number;
  readonly criticalPathMs: number;
  readonly objectBytes: CheckoutObjectBytes;
  readonly digests: CheckoutDigests;
  readonly revListCount: number;
}

export interface CheckoutBenchmarkCapture {
  readonly version: typeof CHECKOUT_BENCHMARK_VERSION;
  readonly kind: 'checkout-benchmark-capture';
  readonly profileDigest: string;
  readonly capturedAt: string;
  readonly runUrl: string;
  readonly environment: {
    readonly runnerOs: string;
    readonly architecture: string;
    readonly gitVersion: string;
    readonly nodeVersion: string;
  };
  readonly samples: readonly CheckoutBenchmarkSample[];
}

export interface CheckoutDistribution {
  readonly samples: number;
  readonly minimum: number;
  readonly p50NearestRank: number;
  readonly p95NearestRank: number;
  readonly maximum: number;
}

export interface CheckoutStrategyAggregate {
  readonly repositoryId: string;
  readonly strategy: CheckoutStrategy;
  readonly equivalent: boolean;
  readonly checkoutMs: CheckoutDistribution;
  readonly fetchMs: CheckoutDistribution;
  readonly objectHydrationMs: CheckoutDistribution;
  readonly bundleMs: CheckoutDistribution;
  readonly indexSourceMs: CheckoutDistribution;
  readonly criticalPathMs: CheckoutDistribution;
  readonly checkoutObjectBytes: CheckoutDistribution;
  readonly fetchObjectBytes: CheckoutDistribution;
  readonly indexSourceObjectBytes: CheckoutDistribution;
  readonly bundleObjectBytes: CheckoutDistribution;
  readonly finalObjectBytes: CheckoutDistribution;
}

export interface CheckoutBenchmarkDecision {
  readonly status: 'pending' | 'retain-full' | 'candidate-shallow' | 'candidate-partial' | 'invalid';
  readonly selectedStrategy: CheckoutStrategy | null;
  readonly fastestStrategy: CheckoutStrategy | null;
  readonly largeRepositoryId: string | null;
  readonly savedMs: number | null;
  readonly savedPercent: number | null;
  readonly material: boolean;
  readonly cacheEvaluation: 'not-eligible' | 'eligible';
  readonly rejectedStrategies: readonly CheckoutStrategy[];
  readonly reason: string;
}

export interface CheckoutBenchmarkAggregate {
  readonly version: typeof CHECKOUT_BENCHMARK_VERSION;
  readonly kind: 'checkout-benchmark-aggregate';
  readonly status: 'pending' | 'complete' | 'invalid';
  readonly profileDigest: string;
  readonly capturedAt: string | null;
  readonly runUrl: string | null;
  readonly environment: CheckoutBenchmarkCapture['environment'] | null;
  readonly repositories: readonly Pick<CheckoutBenchmarkRepository, 'id' | 'label' | 'sizeClass' | 'repository' | 'base' | 'head'>[];
  readonly strategies: readonly CheckoutStrategyAggregate[];
  readonly decision: CheckoutBenchmarkDecision;
  readonly limitations: readonly string[];
}

type JsonObject = Record<string, unknown>;

function record(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing field: ${key}`);
  }
}

function boundedText(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.trim()) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function finitePercentage(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a percentage from 0 through 100`);
  }
  return value;
}

function commit(value: unknown, label: string): string {
  const parsed = boundedText(value, label, 64);
  if (!COMMIT_PATTERN.test(parsed)) throw new Error(`${label} must be a full commit identifier`);
  return parsed;
}

function repository(value: unknown, label: string): string {
  const parsed = boundedText(value, label, 200);
  if (!REPOSITORY_PATTERN.test(parsed)) throw new Error(`${label} must use owner/name syntax`);
  return parsed;
}

function githubUrl(value: unknown, expectedRepository: string, label: string): string {
  const parsed = boundedText(value, label, 300);
  const match = HTTPS_GITHUB_PATTERN.exec(parsed);
  if (match === null || `${match[1]}/${match[2]}` !== expectedRepository) {
    throw new Error(`${label} must be the HTTPS GitHub URL for ${expectedRepository}`);
  }
  return parsed;
}

function strategy(value: unknown, label: string): CheckoutStrategy {
  if (typeof value !== 'string' || !CHECKOUT_STRATEGIES.includes(value as CheckoutStrategy)) {
    throw new Error(`${label} is unsupported`);
  }
  return value as CheckoutStrategy;
}

export function parseCheckoutBenchmarkProfile(value: unknown): CheckoutBenchmarkProfile {
  const item = record(value, 'checkout benchmark profile');
  exactKeys(item, [
    'version', 'kind', 'repetitions', 'commandTimeoutMs', 'materiality', 'strategies', 'repositories',
  ], 'checkout benchmark profile');
  if (item.version !== CHECKOUT_BENCHMARK_VERSION || item.kind !== 'checkout-benchmark-profile') {
    throw new Error('checkout benchmark profile identity is unsupported');
  }
  const repetitions = positiveInteger(item.repetitions, 'checkout benchmark profile.repetitions');
  if (repetitions !== 5) throw new Error('checkout benchmark profile requires exactly five repetitions');
  const commandTimeoutMs = positiveInteger(item.commandTimeoutMs, 'checkout benchmark profile.commandTimeoutMs');
  if (commandTimeoutMs > 30 * 60_000) throw new Error('checkout benchmark command timeout exceeds 30 minutes');
  const materiality = record(item.materiality, 'checkout benchmark profile.materiality');
  exactKeys(materiality, ['minimumSavedMs', 'minimumSavedPercent', 'simplicityWindowPercent'], 'checkout benchmark profile.materiality');
  const parsedMateriality = {
    minimumSavedMs: positiveInteger(materiality.minimumSavedMs, 'materiality.minimumSavedMs'),
    minimumSavedPercent: finitePercentage(materiality.minimumSavedPercent, 'materiality.minimumSavedPercent'),
    simplicityWindowPercent: finitePercentage(materiality.simplicityWindowPercent, 'materiality.simplicityWindowPercent'),
  };
  if (!Array.isArray(item.strategies) || item.strategies.length !== CHECKOUT_STRATEGIES.length) {
    throw new Error('checkout benchmark profile must contain all checkout strategies exactly once');
  }
  const strategies = item.strategies.map((entry, index) => strategy(entry, `strategies[${index}]`));
  if (new Set(strategies).size !== CHECKOUT_STRATEGIES.length
    || CHECKOUT_STRATEGIES.some((entry) => !strategies.includes(entry))) {
    throw new Error('checkout benchmark profile must contain all checkout strategies exactly once');
  }
  if (!Array.isArray(item.repositories) || item.repositories.length !== 2 || item.repositories.length > MAX_REPOSITORIES) {
    throw new Error('checkout benchmark profile must contain one small and one large repository');
  }
  const repositories = item.repositories.map((entry, index): CheckoutBenchmarkRepository => {
    const candidate = record(entry, `repositories[${index}]`);
    exactKeys(candidate, ['id', 'label', 'sizeClass', 'repository', 'baseUrl', 'headUrl', 'base', 'head'], `repositories[${index}]`);
    const repositoryIdentity = repository(candidate.repository, `repositories[${index}].repository`);
    const sizeClass = candidate.sizeClass;
    if (sizeClass !== 'small' && sizeClass !== 'large') throw new Error(`repositories[${index}].sizeClass is unsupported`);
    return {
      id: boundedText(candidate.id, `repositories[${index}].id`, 64),
      label: boundedText(candidate.label, `repositories[${index}].label`, 120),
      sizeClass,
      repository: repositoryIdentity,
      baseUrl: githubUrl(candidate.baseUrl, repositoryIdentity, `repositories[${index}].baseUrl`),
      headUrl: githubUrl(candidate.headUrl, repositoryIdentity, `repositories[${index}].headUrl`),
      base: commit(candidate.base, `repositories[${index}].base`),
      head: commit(candidate.head, `repositories[${index}].head`),
    };
  });
  if (new Set(repositories.map((entry) => entry.id)).size !== repositories.length) {
    throw new Error('checkout benchmark repository ids must be unique');
  }
  if (!repositories.some((entry) => entry.sizeClass === 'small')
    || !repositories.some((entry) => entry.sizeClass === 'large')) {
    throw new Error('checkout benchmark profile requires small and large repositories');
  }
  return Object.freeze({
    version: CHECKOUT_BENCHMARK_VERSION,
    kind: 'checkout-benchmark-profile',
    repetitions,
    commandTimeoutMs,
    materiality: Object.freeze(parsedMateriality),
    strategies: Object.freeze(strategies),
    repositories: Object.freeze(repositories),
  });
}

export function checkoutProfileDigest(profile: CheckoutBenchmarkProfile): string {
  return createHash('sha256').update(JSON.stringify(profile), 'utf8').digest('hex');
}

function parseObjectBytes(value: unknown, label: string): CheckoutObjectBytes {
  const item = record(value, label);
  exactKeys(item, ['afterCheckout', 'addedByFetch', 'addedByIndexSource', 'addedByBundle', 'final'], label);
  return {
    afterCheckout: nonNegativeInteger(item.afterCheckout, `${label}.afterCheckout`),
    addedByFetch: nonNegativeInteger(item.addedByFetch, `${label}.addedByFetch`),
    addedByIndexSource: nonNegativeInteger(item.addedByIndexSource, `${label}.addedByIndexSource`),
    addedByBundle: nonNegativeInteger(item.addedByBundle, `${label}.addedByBundle`),
    final: nonNegativeInteger(item.final, `${label}.final`),
  };
}

function parseDigests(value: unknown, label: string): CheckoutDigests {
  const item = record(value, label);
  exactKeys(item, ['bundle', 'reviewSource', 'baseSource', 'headSource', 'revList'], label);
  const digest = (entry: unknown, field: string): string => {
    const parsed = boundedText(entry, `${label}.${field}`, 64);
    if (!/^[0-9a-f]{64}$/u.test(parsed)) throw new Error(`${label}.${field} must be a SHA-256 digest`);
    return parsed;
  };
  return {
    bundle: digest(item.bundle, 'bundle'),
    reviewSource: digest(item.reviewSource, 'reviewSource'),
    baseSource: digest(item.baseSource, 'baseSource'),
    headSource: digest(item.headSource, 'headSource'),
    revList: digest(item.revList, 'revList'),
  };
}

function parseSample(value: unknown, label: string): CheckoutBenchmarkSample {
  const item = record(value, label);
  exactKeys(item, [
    'repositoryId', 'strategy', 'repetition', 'checkoutMs', 'fetchMs', 'bundleColdMs', 'bundleWarmMs',
    'indexSourceColdMs', 'indexSourceWarmMs', 'objectHydrationMs', 'criticalPathMs', 'objectBytes', 'digests',
    'revListCount',
  ], label);
  return {
    repositoryId: boundedText(item.repositoryId, `${label}.repositoryId`, 64),
    strategy: strategy(item.strategy, `${label}.strategy`),
    repetition: positiveInteger(item.repetition, `${label}.repetition`),
    checkoutMs: nonNegativeInteger(item.checkoutMs, `${label}.checkoutMs`),
    fetchMs: nonNegativeInteger(item.fetchMs, `${label}.fetchMs`),
    bundleColdMs: nonNegativeInteger(item.bundleColdMs, `${label}.bundleColdMs`),
    bundleWarmMs: nonNegativeInteger(item.bundleWarmMs, `${label}.bundleWarmMs`),
    indexSourceColdMs: nonNegativeInteger(item.indexSourceColdMs, `${label}.indexSourceColdMs`),
    indexSourceWarmMs: nonNegativeInteger(item.indexSourceWarmMs, `${label}.indexSourceWarmMs`),
    objectHydrationMs: nonNegativeInteger(item.objectHydrationMs, `${label}.objectHydrationMs`),
    criticalPathMs: nonNegativeInteger(item.criticalPathMs, `${label}.criticalPathMs`),
    objectBytes: parseObjectBytes(item.objectBytes, `${label}.objectBytes`),
    digests: parseDigests(item.digests, `${label}.digests`),
    revListCount: nonNegativeInteger(item.revListCount, `${label}.revListCount`),
  };
}

export function parseCheckoutBenchmarkCapture(value: unknown): CheckoutBenchmarkCapture {
  const item = record(value, 'checkout benchmark capture');
  exactKeys(item, ['version', 'kind', 'profileDigest', 'capturedAt', 'runUrl', 'environment', 'samples'], 'checkout benchmark capture');
  if (item.version !== CHECKOUT_BENCHMARK_VERSION || item.kind !== 'checkout-benchmark-capture') {
    throw new Error('checkout benchmark capture identity is unsupported');
  }
  const environment = record(item.environment, 'checkout benchmark capture.environment');
  exactKeys(environment, ['runnerOs', 'architecture', 'gitVersion', 'nodeVersion'], 'checkout benchmark capture.environment');
  if (!Array.isArray(item.samples) || item.samples.length > MAX_SAMPLES) throw new Error('checkout benchmark capture samples are invalid');
  return {
    version: CHECKOUT_BENCHMARK_VERSION,
    kind: 'checkout-benchmark-capture',
    profileDigest: boundedText(item.profileDigest, 'checkout benchmark capture.profileDigest', 64),
    capturedAt: boundedText(item.capturedAt, 'checkout benchmark capture.capturedAt', 64),
    runUrl: boundedText(item.runUrl, 'checkout benchmark capture.runUrl', 500),
    environment: {
      runnerOs: boundedText(environment.runnerOs, 'capture.environment.runnerOs', 100),
      architecture: boundedText(environment.architecture, 'capture.environment.architecture', 100),
      gitVersion: boundedText(environment.gitVersion, 'capture.environment.gitVersion', 100),
      nodeVersion: boundedText(environment.nodeVersion, 'capture.environment.nodeVersion', 100),
    },
    samples: item.samples.map((entry, index) => parseSample(entry, `samples[${index}]`)),
  };
}

function distribution(values: readonly number[]): CheckoutDistribution {
  if (values.length === 0) throw new Error('checkout benchmark distribution requires samples');
  const sorted = [...values].sort((left, right) => left - right);
  const nearest = (percentile: number): number => sorted[Math.ceil(sorted.length * percentile) - 1] as number;
  return {
    samples: sorted.length,
    minimum: sorted[0] as number,
    p50NearestRank: nearest(0.5),
    p95NearestRank: nearest(0.95),
    maximum: sorted.at(-1) as number,
  };
}

function aggregateStrategy(
  repositoryId: string,
  strategyId: CheckoutStrategy,
  samples: readonly CheckoutBenchmarkSample[],
  reference: CheckoutDigests,
): CheckoutStrategyAggregate {
  const selected = samples.filter((sample) => sample.repositoryId === repositoryId && sample.strategy === strategyId);
  const equivalent = selected.every((sample) => JSON.stringify(sample.digests) === JSON.stringify(reference));
  return {
    repositoryId,
    strategy: strategyId,
    equivalent,
    checkoutMs: distribution(selected.map((sample) => sample.checkoutMs)),
    fetchMs: distribution(selected.map((sample) => sample.fetchMs)),
    objectHydrationMs: distribution(selected.map((sample) => sample.objectHydrationMs)),
    bundleMs: distribution(selected.map((sample) => sample.bundleWarmMs)),
    indexSourceMs: distribution(selected.map((sample) => sample.indexSourceWarmMs)),
    criticalPathMs: distribution(selected.map((sample) => sample.criticalPathMs)),
    checkoutObjectBytes: distribution(selected.map((sample) => sample.objectBytes.afterCheckout)),
    fetchObjectBytes: distribution(selected.map((sample) => sample.objectBytes.addedByFetch)),
    indexSourceObjectBytes: distribution(selected.map((sample) => sample.objectBytes.addedByIndexSource)),
    bundleObjectBytes: distribution(selected.map((sample) => sample.objectBytes.addedByBundle)),
    finalObjectBytes: distribution(selected.map((sample) => sample.objectBytes.final)),
  };
}

const STRATEGY_SIMPLICITY: readonly CheckoutStrategy[] = ['full', 'shallow', 'partial'];

function benchmarkDecision(
  profile: CheckoutBenchmarkProfile,
  strategies: readonly CheckoutStrategyAggregate[],
): CheckoutBenchmarkDecision {
  const correctStrategies = STRATEGY_SIMPLICITY.filter((strategyId) =>
    profile.repositories.every((repositoryEntry) => strategies.some((entry) =>
      entry.repositoryId === repositoryEntry.id && entry.strategy === strategyId && entry.equivalent)));
  const rejectedStrategies = STRATEGY_SIMPLICITY.filter((strategyId) => !correctStrategies.includes(strategyId));
  if (!correctStrategies.includes('full')) {
    return {
      status: 'invalid', selectedStrategy: null, fastestStrategy: null, largeRepositoryId: null,
      savedMs: null, savedPercent: null, material: false, cacheEvaluation: 'not-eligible',
      rejectedStrategies,
      reason: 'Repeated full-checkout samples changed the authoritative bundle, source export, or revision-list digest.',
    };
  }
  const large = profile.repositories.find((entry) => entry.sizeClass === 'large') as CheckoutBenchmarkRepository;
  const candidates = strategies.filter((entry) =>
    entry.repositoryId === large.id && correctStrategies.includes(entry.strategy));
  const fastest = [...candidates].sort((left, right) => left.criticalPathMs.p95NearestRank - right.criticalPathMs.p95NearestRank)[0] as CheckoutStrategyAggregate;
  const full = candidates.find((entry) => entry.strategy === 'full') as CheckoutStrategyAggregate;
  const window = fastest.criticalPathMs.p95NearestRank * (1 + profile.materiality.simplicityWindowPercent / 100);
  const selected = STRATEGY_SIMPLICITY
    .map((entry) => candidates.find((candidate) => candidate.strategy === entry))
    .find((entry) => entry !== undefined && entry.criticalPathMs.p95NearestRank <= window) as CheckoutStrategyAggregate;
  const savedMs = Math.max(0, full.criticalPathMs.p95NearestRank - selected.criticalPathMs.p95NearestRank);
  const savedPercent = full.criticalPathMs.p95NearestRank === 0
    ? 0
    : Number(((savedMs / full.criticalPathMs.p95NearestRank) * 100).toFixed(2));
  const material = savedMs >= profile.materiality.minimumSavedMs
    && savedPercent >= profile.materiality.minimumSavedPercent;
  if (!material || selected.strategy === 'full') {
    return {
      status: 'retain-full',
      selectedStrategy: 'full',
      fastestStrategy: fastest.strategy,
      largeRepositoryId: large.id,
      savedMs,
      savedPercent,
      material,
      cacheEvaluation: 'not-eligible',
      rejectedStrategies,
      reason: selected.strategy === 'full'
        ? rejectedStrategies.length === 0
          ? 'Full checkout remains within the agreed simplicity window of the fastest correct strategy.'
          : `Full checkout is retained because ${rejectedStrategies.join(' and ')} changed authoritative output on at least one repository.`
        : `The simplest correct alternative saves ${savedMs} ms (${savedPercent}%), below the combined materiality gate.`,
    };
  }
  return {
    status: selected.strategy === 'shallow' ? 'candidate-shallow' : 'candidate-partial',
    selectedStrategy: selected.strategy,
    fastestStrategy: fastest.strategy,
    largeRepositoryId: large.id,
    savedMs,
    savedPercent,
    material: true,
    cacheEvaluation: 'eligible',
    rejectedStrategies,
    reason: `${selected.strategy} is the simplest correct strategy within ${profile.materiality.simplicityWindowPercent}% of fastest and crosses both materiality thresholds.`,
  };
}

const LIMITATIONS = [
  'GitHub-hosted network and server load vary; five nearest-rank samples provide bounded evidence, not a universal latency guarantee.',
  'The full strategy fetches complete history reachable from the pinned base, which approximates the current fetch-depth-zero path without fetching unrelated branches.',
  'Object bytes measure the local Git object store after each stage, not wire-level compressed transfer bytes.',
  'Synthetic repositories prove fork, force-push, merge-commit, and shallow-history correctness; public repositories supply transfer-scale evidence.',
  'Pull request source remains data: the benchmark invokes Git and trusted Redline tooling only and never runs repository scripts, builds, hooks, or installers.',
];

export function pendingCheckoutBenchmarkAggregate(profile: CheckoutBenchmarkProfile): CheckoutBenchmarkAggregate {
  return {
    version: CHECKOUT_BENCHMARK_VERSION,
    kind: 'checkout-benchmark-aggregate',
    status: 'pending',
    profileDigest: checkoutProfileDigest(profile),
    capturedAt: null,
    runUrl: null,
    environment: null,
    repositories: profile.repositories.map(({ id, label, sizeClass, repository, base, head }) => ({
      id, label, sizeClass, repository, base, head,
    })),
    strategies: [],
    decision: {
      status: 'pending', selectedStrategy: null, fastestStrategy: null, largeRepositoryId: null,
      savedMs: null, savedPercent: null, material: false, cacheEvaluation: 'not-eligible',
      rejectedStrategies: [],
      reason: 'The manual GitHub-hosted benchmark must run after this workflow is available on the default branch.',
    },
    limitations: LIMITATIONS,
  };
}

export function buildCheckoutBenchmarkAggregate(
  profile: CheckoutBenchmarkProfile,
  capture: CheckoutBenchmarkCapture,
): CheckoutBenchmarkAggregate {
  const digest = checkoutProfileDigest(profile);
  if (capture.profileDigest !== digest) throw new Error('checkout benchmark capture does not match the profile digest');
  if (capture.environment.runnerOs !== 'Linux'
    || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/u.test(capture.runUrl)) {
    throw new Error('checkout benchmark capture must come from a GitHub-hosted Linux workflow run');
  }
  const expected = profile.repositories.length * profile.strategies.length * profile.repetitions;
  if (capture.samples.length !== expected) {
    throw new Error(`checkout benchmark capture requires ${expected} samples, received ${capture.samples.length}`);
  }
  const identities = new Set<string>();
  for (const sample of capture.samples) {
    const repositoryEntry = profile.repositories.find((entry) => entry.id === sample.repositoryId);
    if (repositoryEntry === undefined || !profile.strategies.includes(sample.strategy)
      || sample.repetition > profile.repetitions) {
      throw new Error('checkout benchmark sample is outside the profile');
    }
    const identity = `${sample.repositoryId}:${sample.strategy}:${sample.repetition}`;
    if (identities.has(identity)) throw new Error(`duplicate checkout benchmark sample: ${identity}`);
    identities.add(identity);
  }
  const aggregates: CheckoutStrategyAggregate[] = [];
  for (const repositoryEntry of profile.repositories) {
    const reference = capture.samples.find((sample) =>
      sample.repositoryId === repositoryEntry.id && sample.strategy === 'full')?.digests;
    if (reference === undefined) throw new Error(`checkout benchmark has no full reference for ${repositoryEntry.id}`);
    for (const strategyId of profile.strategies) {
      aggregates.push(aggregateStrategy(repositoryEntry.id, strategyId, capture.samples, reference));
    }
  }
  const decision = benchmarkDecision(profile, aggregates);
  return {
    version: CHECKOUT_BENCHMARK_VERSION,
    kind: 'checkout-benchmark-aggregate',
    status: decision.status === 'invalid' ? 'invalid' : 'complete',
    profileDigest: digest,
    capturedAt: capture.capturedAt,
    runUrl: capture.runUrl,
    environment: capture.environment,
    repositories: profile.repositories.map(({ id, label, sizeClass, repository, base, head }) => ({
      id, label, sizeClass, repository, base, head,
    })),
    strategies: aggregates,
    decision,
    limitations: LIMITATIONS,
  };
}

function parseDistribution(value: unknown, label: string): CheckoutDistribution {
  const item = record(value, label);
  exactKeys(item, ['samples', 'minimum', 'p50NearestRank', 'p95NearestRank', 'maximum'], label);
  return {
    samples: positiveInteger(item.samples, `${label}.samples`),
    minimum: nonNegativeInteger(item.minimum, `${label}.minimum`),
    p50NearestRank: nonNegativeInteger(item.p50NearestRank, `${label}.p50NearestRank`),
    p95NearestRank: nonNegativeInteger(item.p95NearestRank, `${label}.p95NearestRank`),
    maximum: nonNegativeInteger(item.maximum, `${label}.maximum`),
  };
}

export function parseCheckoutBenchmarkAggregate(value: unknown): CheckoutBenchmarkAggregate {
  const item = record(value, 'checkout benchmark aggregate');
  exactKeys(item, [
    'version', 'kind', 'status', 'profileDigest', 'capturedAt', 'runUrl', 'environment', 'repositories',
    'strategies', 'decision', 'limitations',
  ], 'checkout benchmark aggregate');
  if (item.version !== CHECKOUT_BENCHMARK_VERSION || item.kind !== 'checkout-benchmark-aggregate') {
    throw new Error('checkout benchmark aggregate identity is unsupported');
  }
  if (item.status !== 'pending' && item.status !== 'complete' && item.status !== 'invalid') {
    throw new Error('checkout benchmark aggregate status is unsupported');
  }
  if (!Array.isArray(item.repositories) || item.repositories.length !== 2
    || !Array.isArray(item.strategies) || ![0, 6].includes(item.strategies.length)
    || !Array.isArray(item.limitations) || item.limitations.length === 0 || item.limitations.length > 16) {
    throw new Error('checkout benchmark aggregate arrays are invalid');
  }
  const repositories = item.repositories.map((entry, index) => {
    const candidate = record(entry, `aggregate.repositories[${index}]`);
    exactKeys(candidate, ['id', 'label', 'sizeClass', 'repository', 'base', 'head'], `aggregate.repositories[${index}]`);
    if (candidate.sizeClass !== 'small' && candidate.sizeClass !== 'large') throw new Error('aggregate repository size class is unsupported');
    const sizeClass: 'small' | 'large' = candidate.sizeClass;
    return {
      id: boundedText(candidate.id, `aggregate.repositories[${index}].id`, 64),
      label: boundedText(candidate.label, `aggregate.repositories[${index}].label`, 120),
      sizeClass,
      repository: repository(candidate.repository, `aggregate.repositories[${index}].repository`),
      base: commit(candidate.base, `aggregate.repositories[${index}].base`),
      head: commit(candidate.head, `aggregate.repositories[${index}].head`),
    };
  });
  const strategies = item.strategies.map((entry, index): CheckoutStrategyAggregate => {
    const candidate = record(entry, `aggregate.strategies[${index}]`);
    exactKeys(candidate, [
      'repositoryId', 'strategy', 'equivalent', 'checkoutMs', 'fetchMs', 'objectHydrationMs', 'bundleMs',
      'indexSourceMs', 'criticalPathMs', 'checkoutObjectBytes', 'fetchObjectBytes', 'indexSourceObjectBytes',
      'bundleObjectBytes', 'finalObjectBytes',
    ], `aggregate.strategies[${index}]`);
    if (typeof candidate.equivalent !== 'boolean') throw new Error('aggregate strategy equivalent must be boolean');
    return {
      repositoryId: boundedText(candidate.repositoryId, `aggregate.strategies[${index}].repositoryId`, 64),
      strategy: strategy(candidate.strategy, `aggregate.strategies[${index}].strategy`),
      equivalent: candidate.equivalent,
      checkoutMs: parseDistribution(candidate.checkoutMs, `aggregate.strategies[${index}].checkoutMs`),
      fetchMs: parseDistribution(candidate.fetchMs, `aggregate.strategies[${index}].fetchMs`),
      objectHydrationMs: parseDistribution(candidate.objectHydrationMs, `aggregate.strategies[${index}].objectHydrationMs`),
      bundleMs: parseDistribution(candidate.bundleMs, `aggregate.strategies[${index}].bundleMs`),
      indexSourceMs: parseDistribution(candidate.indexSourceMs, `aggregate.strategies[${index}].indexSourceMs`),
      criticalPathMs: parseDistribution(candidate.criticalPathMs, `aggregate.strategies[${index}].criticalPathMs`),
      checkoutObjectBytes: parseDistribution(candidate.checkoutObjectBytes, `aggregate.strategies[${index}].checkoutObjectBytes`),
      fetchObjectBytes: parseDistribution(candidate.fetchObjectBytes, `aggregate.strategies[${index}].fetchObjectBytes`),
      indexSourceObjectBytes: parseDistribution(candidate.indexSourceObjectBytes, `aggregate.strategies[${index}].indexSourceObjectBytes`),
      bundleObjectBytes: parseDistribution(candidate.bundleObjectBytes, `aggregate.strategies[${index}].bundleObjectBytes`),
      finalObjectBytes: parseDistribution(candidate.finalObjectBytes, `aggregate.strategies[${index}].finalObjectBytes`),
    };
  });
  const decisionValue = record(item.decision, 'aggregate.decision');
  exactKeys(decisionValue, [
    'status', 'selectedStrategy', 'fastestStrategy', 'largeRepositoryId', 'savedMs', 'savedPercent', 'material',
    'cacheEvaluation', 'rejectedStrategies', 'reason',
  ], 'aggregate.decision');
  const nullableStrategy = (value: unknown, label: string): CheckoutStrategy | null =>
    value === null ? null : strategy(value, label);
  const nullableText = (value: unknown, label: string): string | null =>
    value === null ? null : boundedText(value, label, 200);
  const nullableNumber = (value: unknown, label: string): number | null => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid`);
    return value;
  };
  const decisionStatus = decisionValue.status;
  if (decisionStatus !== 'pending' && decisionStatus !== 'retain-full'
    && decisionStatus !== 'candidate-shallow' && decisionStatus !== 'candidate-partial' && decisionStatus !== 'invalid') {
    throw new Error('aggregate decision status is unsupported');
  }
  if (typeof decisionValue.material !== 'boolean'
    || (decisionValue.cacheEvaluation !== 'not-eligible' && decisionValue.cacheEvaluation !== 'eligible')
    || !Array.isArray(decisionValue.rejectedStrategies) || decisionValue.rejectedStrategies.length > CHECKOUT_STRATEGIES.length) {
    throw new Error('aggregate decision fields are invalid');
  }
  const rejectedStrategies = decisionValue.rejectedStrategies.map((entry, index) =>
    strategy(entry, `aggregate.decision.rejectedStrategies[${index}]`));
  if (new Set(rejectedStrategies).size !== rejectedStrategies.length) {
    throw new Error('aggregate decision rejected strategies contain duplicates');
  }
  const capturedAt = item.capturedAt === null ? null : boundedText(item.capturedAt, 'aggregate.capturedAt', 64);
  const runUrl = item.runUrl === null ? null : boundedText(item.runUrl, 'aggregate.runUrl', 500);
  const environment = item.environment === null ? null : (() => {
    const candidate = record(item.environment, 'aggregate.environment');
    exactKeys(candidate, ['runnerOs', 'architecture', 'gitVersion', 'nodeVersion'], 'aggregate.environment');
    return {
      runnerOs: boundedText(candidate.runnerOs, 'aggregate.environment.runnerOs', 100),
      architecture: boundedText(candidate.architecture, 'aggregate.environment.architecture', 100),
      gitVersion: boundedText(candidate.gitVersion, 'aggregate.environment.gitVersion', 100),
      nodeVersion: boundedText(candidate.nodeVersion, 'aggregate.environment.nodeVersion', 100),
    };
  })();
  if (item.status === 'pending') {
    if (capturedAt !== null || runUrl !== null || environment !== null || strategies.length !== 0 || decisionStatus !== 'pending') {
      throw new Error('pending checkout benchmark aggregate is inconsistent');
    }
  } else if (capturedAt === null || runUrl === null || environment === null || strategies.length !== 6
    || decisionStatus === 'pending' || (item.status === 'invalid') !== (decisionStatus === 'invalid')) {
    throw new Error('completed checkout benchmark aggregate is inconsistent');
  }
  return {
    version: CHECKOUT_BENCHMARK_VERSION,
    kind: 'checkout-benchmark-aggregate',
    status: item.status,
    profileDigest: boundedText(item.profileDigest, 'aggregate.profileDigest', 64),
    capturedAt,
    runUrl,
    environment,
    repositories,
    strategies,
    decision: {
      status: decisionStatus,
      selectedStrategy: nullableStrategy(decisionValue.selectedStrategy, 'aggregate.decision.selectedStrategy'),
      fastestStrategy: nullableStrategy(decisionValue.fastestStrategy, 'aggregate.decision.fastestStrategy'),
      largeRepositoryId: nullableText(decisionValue.largeRepositoryId, 'aggregate.decision.largeRepositoryId'),
      savedMs: nullableNumber(decisionValue.savedMs, 'aggregate.decision.savedMs'),
      savedPercent: nullableNumber(decisionValue.savedPercent, 'aggregate.decision.savedPercent'),
      material: decisionValue.material,
      cacheEvaluation: decisionValue.cacheEvaluation,
      rejectedStrategies,
      reason: boundedText(decisionValue.reason, 'aggregate.decision.reason', 500),
    },
    limitations: item.limitations.map((entry, index) => boundedText(entry, `aggregate.limitations[${index}]`, 500)),
  };
}

function milliseconds(value: number): string {
  return `${value.toLocaleString('en-US')} ms`;
}

function megabytes(value: number): string {
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function millisecondPair(value: CheckoutDistribution): string {
  return `${milliseconds(value.p50NearestRank)} / ${milliseconds(value.p95NearestRank)}`;
}

function megabytePair(value: CheckoutDistribution): string {
  return `${megabytes(value.p50NearestRank)} / ${megabytes(value.p95NearestRank)}`;
}

export function renderCheckoutBenchmarkReport(aggregate: CheckoutBenchmarkAggregate): string {
  const lines = [
    '# Checkout and exact-revision fetch benchmark',
    '',
    `- Status: **${aggregate.status}**`,
    `- Profile digest: \`${aggregate.profileDigest}\``,
    `- Capture: ${aggregate.capturedAt ?? 'pending'}`,
    `- Workflow run: ${aggregate.runUrl === null ? 'pending' : `[${aggregate.runUrl}](${aggregate.runUrl})`}`,
    `- Environment: ${aggregate.environment === null ? 'pending' : `${aggregate.environment.runnerOs}/${aggregate.environment.architecture}; ${aggregate.environment.gitVersion}; Node ${aggregate.environment.nodeVersion}`}`,
    `- Decision: **${aggregate.decision.status}** — ${aggregate.decision.reason}`,
    '',
    '## Pinned repositories',
    '',
    '| Corpus | Size | Repository | Base | Head |',
    '| --- | --- | --- | --- | --- |',
    ...aggregate.repositories.map((entry) =>
      `| ${entry.label} | ${entry.sizeClass} | \`${entry.repository}\` | \`${entry.base.slice(0, 12)}\` | \`${entry.head.slice(0, 12)}\` |`),
  ];
  if (aggregate.strategies.length === 0) {
    lines.push(
      '',
      '## Live evidence pending',
      '',
      'The benchmark workflow must first merge to the default branch. Then run five GitHub-hosted repetitions for each repository and strategy, retain raw per-run JSON as the workflow artifact, and replace this pending aggregate with the bounded aggregate output.',
    );
  } else {
    lines.push(
      '',
      '## Stage timings (nearest-rank p50 / p95)',
      '',
      '| Repository | Strategy | Equivalent | Checkout | Exact fetch | Object hydration | Bundle | Index source export | Critical path |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const entry of aggregate.strategies) {
      lines.push(`| ${entry.repositoryId} | ${entry.strategy} | ${entry.equivalent ? 'yes' : 'no'} | ${millisecondPair(entry.checkoutMs)} | ${millisecondPair(entry.fetchMs)} | ${millisecondPair(entry.objectHydrationMs)} | ${millisecondPair(entry.bundleMs)} | ${millisecondPair(entry.indexSourceMs)} | ${millisecondPair(entry.criticalPathMs)} |`);
    }
    lines.push(
      '',
      '## Local Git object-store bytes (nearest-rank p50 / p95)',
      '',
      '| Repository | Strategy | After checkout | Added by exact fetch | Added by index source | Added by bundle | Final |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const entry of aggregate.strategies) {
      lines.push(`| ${entry.repositoryId} | ${entry.strategy} | ${megabytePair(entry.checkoutObjectBytes)} | ${megabytePair(entry.fetchObjectBytes)} | ${megabytePair(entry.indexSourceObjectBytes)} | ${megabytePair(entry.bundleObjectBytes)} | ${megabytePair(entry.finalObjectBytes)} |`);
    }
    lines.push(
      '',
      '## Decision gate',
      '',
      `- Selected strategy: ${aggregate.decision.selectedStrategy ?? 'none'}`,
      `- Fastest strategy: ${aggregate.decision.fastestStrategy ?? 'none'}`,
      `- Saved on large repository: ${aggregate.decision.savedMs === null ? 'n/a' : milliseconds(aggregate.decision.savedMs)} (${aggregate.decision.savedPercent === null ? 'n/a' : `${aggregate.decision.savedPercent}%`})`,
      `- Material: ${aggregate.decision.material ? 'yes' : 'no'}`,
      `- Rejected strategies: ${aggregate.decision.rejectedStrategies.length === 0 ? 'none' : aggregate.decision.rejectedStrategies.join(', ')}`,
      `- Git object cache evaluation: ${aggregate.decision.cacheEvaluation}`,
    );
  }
  lines.push('', '## Limitations', '', ...aggregate.limitations.map((entry) => `- ${entry}`), '');
  return lines.join('\n');
}

async function readBoundedJson(path: string, maximumBytes: number, label: string): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error(`${label} exceeds its file bound`);
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export function validateCheckoutBenchmarkAggregate(
  profile: CheckoutBenchmarkProfile,
  aggregate: CheckoutBenchmarkAggregate,
): void {
  if (aggregate.profileDigest !== checkoutProfileDigest(profile)) {
    throw new Error('checkout benchmark aggregate does not match the profile digest');
  }
  const expectedRepositories = profile.repositories.map(({ id, label, sizeClass, repository, base, head }) => ({
    id, label, sizeClass, repository, base, head,
  }));
  if (JSON.stringify(aggregate.repositories) !== JSON.stringify(expectedRepositories)) {
    throw new Error('checkout benchmark aggregate repositories do not match the profile');
  }
  if (aggregate.status === 'pending') return;
  const identities = new Set<string>();
  for (const entry of aggregate.strategies) {
    const identity = `${entry.repositoryId}:${entry.strategy}`;
    if (identities.has(identity)) throw new Error(`duplicate checkout benchmark aggregate strategy: ${identity}`);
    identities.add(identity);
    if (!profile.repositories.some((repositoryEntry) => repositoryEntry.id === entry.repositoryId)
      || !profile.strategies.includes(entry.strategy)) {
      throw new Error('checkout benchmark aggregate strategy is outside the profile');
    }
    for (const value of [
      entry.checkoutMs, entry.fetchMs, entry.objectHydrationMs, entry.bundleMs,
      entry.indexSourceMs, entry.criticalPathMs, entry.checkoutObjectBytes, entry.fetchObjectBytes,
      entry.indexSourceObjectBytes, entry.bundleObjectBytes, entry.finalObjectBytes,
    ]) {
      if (value.samples !== profile.repetitions) throw new Error('checkout benchmark aggregate sample count is invalid');
    }
  }
  const expectedIdentities = profile.repositories.flatMap((repositoryEntry) =>
    profile.strategies.map((strategyId) => `${repositoryEntry.id}:${strategyId}`));
  if (expectedIdentities.some((identity) => !identities.has(identity))) {
    throw new Error('checkout benchmark aggregate is missing a strategy');
  }
}

export async function loadCheckoutBenchmarkProfile(path: string): Promise<CheckoutBenchmarkProfile> {
  return parseCheckoutBenchmarkProfile(await readBoundedJson(path, 64 * 1024, 'checkout benchmark profile'));
}

export async function loadCheckoutBenchmarkAggregate(path: string): Promise<CheckoutBenchmarkAggregate> {
  return parseCheckoutBenchmarkAggregate(await readBoundedJson(path, 1024 * 1024, 'checkout benchmark aggregate'));
}

export async function writeCheckoutBenchmarkAggregate(path: string, aggregate: CheckoutBenchmarkAggregate): Promise<void> {
  await writeFile(path, `${JSON.stringify(aggregate, null, 2)}\n`);
}

export async function writeCheckoutBenchmarkReport(path: string, aggregate: CheckoutBenchmarkAggregate): Promise<void> {
  await writeFile(path, renderCheckoutBenchmarkReport(aggregate));
}
