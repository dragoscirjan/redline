import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CodeContextTimings } from '../code-context/artifact.ts';
import { parseDuration, type Duration } from '../duration.ts';
import type {
  HarnessCredential,
  HarnessExecuteOptions,
  HarnessExecutor,
  HarnessName,
  HarnessPrompt,
  HarnessRun,
  HarnessSettings,
  PreparedHarness,
} from '../harness-executor/types.ts';
import { publishRecords } from '../publish/service.ts';
import type { FileReviewPublication, ReviewPublisher, ReviewScope } from '../publish/types.ts';
import type { ReviewEnvironment } from '../review/environment.ts';
import { loadPublishedRun } from '../review/run-output.ts';
import { runFileReviews } from '../review/runner.ts';
import type { FileReviewRecord } from '../review/types.ts';
import { materializeBenchmarkFixture, type FixtureRecording } from './benchmark.ts';
import {
  loadPerformanceCorpus,
  type PerformanceCorpus,
  type PerformanceCorpusFile,
  type PerformanceFileCategory,
} from './performance-corpus.ts';

const PERFORMANCE_PROFILE_VERSION = 1 as const;
const PERFORMANCE_REPORT_VERSION = 2 as const;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_RUNS = 20;
const TOKEN_ESTIMATE_CHARS = 4;

export type PerformanceSource = 'recorded' | 'live';
export type PerformanceConditionId = 'warm-index' | 'cold-index';

interface PerformanceConfiguration {
  readonly harness: 'pi' | 'opencode';
  readonly provider: string;
  readonly endpoint: string;
  readonly model: string;
  readonly indexProvider: 'cgc' | 'gitnexus';
  readonly indexProviderVersion: string;
  readonly execution: 'bounded-parallel';
  readonly reviewConcurrency: number;
}

interface PerformanceTargets {
  readonly warmIndexP95Ms: number;
  readonly coldIndexP95Ms: number;
  readonly minimumLiveCorpusRuns: number;
}

interface IndexSample extends CodeContextTimings {
  readonly source: string;
  readonly checkoutFetchMs: number;
  readonly runtimeSetupMs: number;
  readonly dependencyInstallBuildMs: number;
  readonly harnessInstallMs: number;
  readonly contextBundleMs: number;
  readonly reviewValidationWritingMs: number;
  readonly publicationMs: number;
  readonly otherMs: number;
}

interface IndexCondition {
  readonly id: PerformanceConditionId;
  readonly cache: 'restored' | 'built';
  readonly samples: readonly IndexSample[];
}

export interface PerformanceProfile {
  readonly version: typeof PERFORMANCE_PROFILE_VERSION;
  readonly id: string;
  readonly configuration: PerformanceConfiguration;
  readonly targets: PerformanceTargets;
  readonly conditions: readonly IndexCondition[];
}

export interface PerformanceFileSample {
  readonly fileId: string;
  readonly path: string;
  readonly category: PerformanceFileCategory;
  readonly status: HarnessRun['status'];
  readonly outcome: FileReviewRecord['outcome'];
  readonly errorKind: FileReviewRecord['errorKind'] | null;
  readonly queueWaitMs: number;
  readonly modelDurationMs: number;
  readonly promptBytes: number;
  readonly baselinePromptBytes: number;
  readonly promptReductionBytes: number;
  readonly promptReductionPercent: number;
  readonly estimatedInputTokens: number;
  readonly baselineEstimatedInputTokens: number;
  readonly estimatedInputTokenReduction: number;
  readonly estimatedOutputTokens: number;
  readonly processStartupMs: number | null;
  readonly timeToFirstTextMs: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface PerformanceRunStages {
  readonly checkoutFetchMs: null;
  readonly runtimeSetupInstallMs: null;
  readonly contextBundleBuildMs: number;
  readonly reviewBundleLoadMs: number;
  readonly harnessPreparationMs: number;
  readonly filePreparationMs: number;
  readonly modelMs: number;
  readonly validationMs: number;
  readonly writingMs: number;
  readonly summaryWritingMs: number;
  readonly publicationMs: number;
}

export interface PerformanceRunSample {
  readonly run: number;
  readonly reviewConcurrency: number;
  readonly maximumActiveModelCalls: number;
  readonly reviewWallMs: number;
  readonly totalModelWorkMs: number;
  readonly stages: PerformanceRunStages;
  readonly modeledReviewMs: number;
  readonly publicationMs: number;
  readonly promptBytes: number;
  readonly baselinePromptBytes: number;
  readonly promptReductionBytes: number;
  readonly promptReductionPercent: number;
  readonly medianPromptReductionBytes: number;
  readonly medianPromptReductionPercent: number;
  readonly estimatedInputTokens: number;
  readonly baselineEstimatedInputTokens: number;
  readonly estimatedInputTokenReduction: number;
  readonly estimatedOutputTokens: number;
  readonly actualInputTokens: number | null;
  readonly actualOutputTokens: number | null;
  readonly costUsd: number | null;
  readonly reviewedFiles: number;
  readonly omittedFiles: number;
  readonly invalidFiles: number;
  readonly findings: number;
  readonly rejectedCandidates: number;
  readonly coverageComplete: boolean;
  readonly publicationComplete: boolean;
  readonly files: readonly PerformanceFileSample[];
}

interface Distribution {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
}

export interface PerformanceConditionResult extends Distribution {
  readonly id: PerformanceConditionId;
  readonly cache: 'restored' | 'built';
  readonly targetMs: number;
  readonly withinTarget: boolean;
  readonly sloEligible: boolean;
  readonly sloPassed: boolean | null;
  readonly indexSamples: number;
  readonly indexP50Ms: number;
  readonly indexP95Ms: number;
  readonly stageP50Ms: {
    readonly checkoutFetch: number;
    readonly runtimeSetup: number;
    readonly indexInstallation: number;
    readonly indexRestore: number;
    readonly indexBuild: number;
    readonly indexQuery: number;
    readonly indexSave: number;
    readonly dependencyInstallBuild: number;
    readonly harnessInstall: number;
    readonly contextBundle: number;
    readonly reviewValidationWriting: number;
    readonly publication: number;
    readonly other: number;
  };
}

export interface PerformanceQualityGate {
  readonly passed: boolean;
  readonly requiredFiles: number;
  readonly reviewedFiles: number;
  readonly omittedFiles: number;
  readonly invalidFiles: number;
  readonly findingsOnCleanCorpus: number;
  readonly rejectedCandidates: number;
  readonly incompleteCoverageRuns: number;
  readonly incompletePublicationRuns: number;
}

export interface PerformanceReport {
  readonly version: typeof PERFORMANCE_REPORT_VERSION;
  readonly kind: 'review-performance';
  readonly source: PerformanceSource;
  readonly createdAt: string | null;
  readonly corpus: {
    readonly id: string;
    readonly title: string;
    readonly files: number;
    readonly categories: Readonly<Record<PerformanceFileCategory, number>>;
  };
  readonly profile: {
    readonly id: string;
    readonly harness: string;
    readonly provider: string;
    readonly model: string;
    readonly indexProvider: string;
    readonly indexProviderVersion: string;
    readonly execution: 'bounded-parallel';
    readonly reviewConcurrency: number;
  };
  readonly targets: PerformanceTargets;
  readonly quality: PerformanceQualityGate;
  readonly runs: readonly PerformanceRunSample[];
  readonly conditions: readonly PerformanceConditionResult[];
  readonly limitations: readonly string[];
}

export interface LivePerformanceConfiguration {
  readonly harness: 'pi' | 'opencode';
  readonly model: ReviewEnvironment['model'];
  readonly credential: HarnessCredential | undefined;
  readonly timeout: Duration;
  readonly executorFactory: () => HarnessExecutor;
}

export interface RunPerformanceOptions {
  readonly corpusPath: string;
  readonly profilePath: string;
  readonly source: PerformanceSource;
  readonly runs: number;
  readonly live?: LivePerformanceConfiguration | undefined;
  readonly now?: (() => Date) | undefined;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown key: ${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${label} is missing key: ${key}`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function parseTiming(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label, 0, 24 * 60 * 60 * 1_000);
}

function parseProfile(value: unknown): PerformanceProfile {
  const input = record(value, 'performance profile');
  exactKeys(input, ['version', 'id', 'configuration', 'targets', 'conditions'], 'performance profile');
  if (input['version'] !== PERFORMANCE_PROFILE_VERSION) {
    throw new Error(`performance profile.version must be ${PERFORMANCE_PROFILE_VERSION}`);
  }
  const configuration = record(input['configuration'], 'performance profile.configuration');
  exactKeys(configuration, [
    'harness', 'provider', 'endpoint', 'model', 'indexProvider', 'indexProviderVersion', 'execution',
    'reviewConcurrency',
  ], 'performance profile.configuration');
  if (configuration['harness'] !== 'pi' && configuration['harness'] !== 'opencode') {
    throw new Error('performance profile.configuration.harness is unsupported');
  }
  if (configuration['indexProvider'] !== 'cgc' && configuration['indexProvider'] !== 'gitnexus') {
    throw new Error('performance profile.configuration.indexProvider is unsupported');
  }
  if (configuration['execution'] !== 'bounded-parallel') {
    throw new Error('performance profile.configuration.execution must be bounded-parallel');
  }
  const targets = record(input['targets'], 'performance profile.targets');
  exactKeys(
    targets,
    ['warmIndexP95Ms', 'coldIndexP95Ms', 'minimumLiveCorpusRuns'],
    'performance profile.targets',
  );
  const conditionsInput = input['conditions'];
  if (!Array.isArray(conditionsInput) || conditionsInput.length !== 2) {
    throw new Error('performance profile.conditions must contain warm-index and cold-index');
  }
  const conditions = conditionsInput.map((conditionValue, conditionIndex): IndexCondition => {
    const label = `performance profile.conditions[${conditionIndex}]`;
    const condition = record(conditionValue, label);
    exactKeys(condition, ['id', 'cache', 'samples'], label);
    const id = condition['id'];
    if (id !== 'warm-index' && id !== 'cold-index') throw new Error(`${label}.id is unsupported`);
    const expectedCache = id === 'warm-index' ? 'restored' : 'built';
    if (condition['cache'] !== expectedCache) throw new Error(`${label}.cache must be ${expectedCache}`);
    if (!Array.isArray(condition['samples']) || condition['samples'].length === 0 || condition['samples'].length > 20) {
      throw new Error(`${label}.samples must contain 1 through 20 entries`);
    }
    const samples = condition['samples'].map((sampleValue, sampleIndex): IndexSample => {
      const sampleLabel = `${label}.samples[${sampleIndex}]`;
      const sample = record(sampleValue, sampleLabel);
      exactKeys(sample, [
        'source', 'checkoutFetchMs', 'runtimeSetupMs', 'dependencyInstallBuildMs', 'harnessInstallMs',
        'contextBundleMs', 'reviewValidationWritingMs', 'publicationMs', 'otherMs',
        'installationMs', 'restoreMs', 'indexMs', 'queryMs', 'saveMs',
      ], sampleLabel);
      const source = text(sample['source'], `${sampleLabel}.source`);
      let parsedSource: URL;
      try {
        parsedSource = new URL(source);
      } catch {
        throw new Error(`${sampleLabel}.source must be an HTTPS URL`);
      }
      if (parsedSource.protocol !== 'https:') throw new Error(`${sampleLabel}.source must be an HTTPS URL`);
      return {
        source,
        checkoutFetchMs: integer(sample['checkoutFetchMs'], `${sampleLabel}.checkoutFetchMs`, 0),
        runtimeSetupMs: integer(sample['runtimeSetupMs'], `${sampleLabel}.runtimeSetupMs`, 0),
        dependencyInstallBuildMs: integer(
          sample['dependencyInstallBuildMs'], `${sampleLabel}.dependencyInstallBuildMs`, 0,
        ),
        harnessInstallMs: integer(sample['harnessInstallMs'], `${sampleLabel}.harnessInstallMs`, 0),
        contextBundleMs: integer(sample['contextBundleMs'], `${sampleLabel}.contextBundleMs`, 0),
        reviewValidationWritingMs: integer(
          sample['reviewValidationWritingMs'], `${sampleLabel}.reviewValidationWritingMs`, 0,
        ),
        publicationMs: integer(sample['publicationMs'], `${sampleLabel}.publicationMs`, 0),
        otherMs: integer(sample['otherMs'], `${sampleLabel}.otherMs`, 0),
        installationMs: integer(sample['installationMs'], `${sampleLabel}.installationMs`, 0),
        restoreMs: integer(sample['restoreMs'], `${sampleLabel}.restoreMs`, 0),
        indexMs: integer(sample['indexMs'], `${sampleLabel}.indexMs`, 0),
        queryMs: integer(sample['queryMs'], `${sampleLabel}.queryMs`, 0),
        saveMs: parseTiming(sample['saveMs'], `${sampleLabel}.saveMs`),
      };
    });
    return { id, cache: expectedCache, samples };
  });
  if (new Set(conditions.map((condition) => condition.id)).size !== 2) {
    throw new Error('performance profile.conditions must contain unique warm-index and cold-index entries');
  }
  return {
    version: PERFORMANCE_PROFILE_VERSION,
    id: text(input['id'], 'performance profile.id'),
    configuration: {
      harness: configuration['harness'],
      provider: text(configuration['provider'], 'performance profile.configuration.provider'),
      endpoint: text(configuration['endpoint'], 'performance profile.configuration.endpoint'),
      model: text(configuration['model'], 'performance profile.configuration.model'),
      indexProvider: configuration['indexProvider'],
      indexProviderVersion: text(
        configuration['indexProviderVersion'],
        'performance profile.configuration.indexProviderVersion',
      ),
      execution: 'bounded-parallel',
      reviewConcurrency: integer(
        configuration['reviewConcurrency'],
        'performance profile.configuration.reviewConcurrency',
        1,
        8,
      ),
    },
    targets: {
      warmIndexP95Ms: integer(targets['warmIndexP95Ms'], 'performance profile.targets.warmIndexP95Ms', 1),
      coldIndexP95Ms: integer(targets['coldIndexP95Ms'], 'performance profile.targets.coldIndexP95Ms', 1),
      minimumLiveCorpusRuns: integer(
        targets['minimumLiveCorpusRuns'],
        'performance profile.targets.minimumLiveCorpusRuns',
        1,
        MAX_RUNS,
      ),
    },
    conditions,
  };
}

export async function loadPerformanceProfile(path: string): Promise<PerformanceProfile> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new Error('performance profile must be a regular file without symbolic links');
  }
  if (info.size > MAX_PROFILE_BYTES) throw new Error('performance profile exceeds its byte limit');
  return parseProfile(JSON.parse(await readFile(absolute, 'utf8')) as unknown);
}

class RecordedPerformanceExecutor implements HarnessExecutor {
  readonly harness: HarnessName;
  readonly #responses: ReadonlyMap<string, FixtureRecording['responses'][number]>;
  readonly #used = new Set<string>();

  constructor(harness: HarnessName, responses: FixtureRecording['responses']) {
    this.harness = harness;
    this.#responses = new Map(responses.map((response) => [response.fileId, response]));
  }

  async prepare(settings: HarnessSettings): Promise<PreparedHarness> {
    return { harness: this.harness, model: settings.model, description: 'recorded performance responses' };
  }

  async execute(
    _prepared: PreparedHarness,
    _prompt: HarnessPrompt,
    options?: HarnessExecuteOptions,
  ): Promise<HarnessRun> {
    const fileId = options?.invocation?.fileId;
    if (fileId === undefined) throw new Error('recorded performance invocation has no file id');
    const response = this.#responses.get(fileId);
    if (response === undefined || this.#used.has(fileId)) {
      throw new Error(`recorded performance response is missing or repeated for ${fileId}`);
    }
    this.#used.add(fileId);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const textValue = JSON.stringify(response.document);
    return {
      status: 'succeeded',
      harness: this.harness,
      exitCode: 0,
      text: textValue,
      diagnostic: '',
      durationMs: response.durationMs,
      telemetry: {
        processStartupMs: 0,
        timeToFirstTextMs: 0,
        stdoutBytes: Buffer.byteLength(textValue, 'utf8'),
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    };
  }
}

interface ExecutionMeasurement {
  readonly file: PerformanceCorpusFile;
  readonly status: HarnessRun['status'];
  readonly queueWaitMs: number;
  readonly modelDurationMs: number;
  readonly promptBytes: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly processStartupMs: number | null;
  readonly timeToFirstTextMs: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly wallStartedAt: number;
  readonly wallFinishedAt: number;
}

function estimatedTokens(value: string): number {
  return Math.ceil(value.length / TOKEN_ESTIMATE_CHARS);
}

function reductionPercent(baseline: number, candidate: number): number {
  return baseline === 0 ? 0 : Number((((baseline - candidate) / baseline) * 100).toFixed(2));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

class MeasuringPerformanceExecutor implements HarnessExecutor {
  readonly harness: HarnessName;
  readonly measurements: ExecutionMeasurement[] = [];
  readonly #startedAt = Date.now();
  prepareStartedAt: number | null = null;
  prepareFinishedAt: number | null = null;
  maximumActiveCalls = 0;
  #activeCalls = 0;
  readonly #delegate: HarnessExecutor;
  readonly #files: ReadonlyMap<string, PerformanceCorpusFile>;
  readonly #source: PerformanceSource;

  constructor(
    delegate: HarnessExecutor,
    files: readonly PerformanceCorpusFile[],
    source: PerformanceSource,
  ) {
    this.#delegate = delegate;
    this.#source = source;
    this.harness = delegate.harness;
    this.#files = new Map(files.map((file) => [file.id, file]));
  }

  async prepare(settings: HarnessSettings): Promise<PreparedHarness> {
    this.prepareStartedAt = Date.now();
    try {
      return await this.#delegate.prepare(settings);
    } finally {
      this.prepareFinishedAt = Date.now();
    }
  }

  async execute(
    prepared: PreparedHarness,
    prompt: HarnessPrompt,
    options?: HarnessExecuteOptions,
  ): Promise<HarnessRun> {
    const fileId = options?.invocation?.fileId;
    const file = fileId === undefined ? undefined : this.#files.get(fileId);
    if (file === undefined) throw new Error('performance executor received an invocation without a corpus file');
    const queueWaitMs = this.#source === 'recorded' ? 0 : Math.max(0, Date.now() - this.#startedAt);
    const promptBytes = Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
    const wallStartedAt = Date.now();
    this.#activeCalls += 1;
    this.maximumActiveCalls = Math.max(this.maximumActiveCalls, this.#activeCalls);
    try {
      const run = await this.#delegate.execute(prepared, prompt, options);
      const wallFinishedAt = Date.now();
      const telemetry = run.telemetry;
      this.measurements.push({
        file,
        status: run.status,
        queueWaitMs,
        modelDurationMs: run.durationMs,
        promptBytes,
        estimatedInputTokens: estimatedTokens(`${prompt.system}\n${prompt.user}`),
        estimatedOutputTokens: estimatedTokens(run.text),
        processStartupMs: telemetry?.processStartupMs ?? null,
        timeToFirstTextMs: telemetry?.timeToFirstTextMs ?? null,
        stdoutBytes: telemetry?.stdoutBytes ?? Buffer.byteLength(run.text, 'utf8'),
        stderrBytes: telemetry?.stderrBytes ?? Buffer.byteLength(run.diagnostic, 'utf8'),
        stdoutTruncated: telemetry?.stdoutTruncated ?? false,
        stderrTruncated: telemetry?.stderrTruncated ?? false,
        wallStartedAt,
        wallFinishedAt,
      });
      return run;
    } finally {
      this.#activeCalls -= 1;
    }
  }
}

class BenchmarkPublisher implements ReviewPublisher {
  #nextId = 1;

  async currentHead(scope: ReviewScope): Promise<string> {
    return scope.head;
  }

  async upsertSummary(_scope: ReviewScope, _body: string, _marker: string): Promise<number> {
    return this.#nextId++;
  }

  async publishFileReview(_scope: ReviewScope, _publication: FileReviewPublication): Promise<number> {
    return this.#nextId++;
  }
}

function indexedRecording(corpus: PerformanceCorpus): Extract<FixtureRecording, { mode: 'indexed-context' }> {
  const recording = corpus.fixture.recordings.find(
    (item): item is Extract<FixtureRecording, { mode: 'indexed-context' }> => item.mode === 'indexed-context',
  );
  if (recording === undefined) throw new Error('performance corpus has no indexed-context recording');
  return recording;
}

function scheduledPerformanceFiles(corpus: PerformanceCorpus, concurrency: number): readonly PerformanceCorpusFile[] {
  if (concurrency === 1) return corpus.files;
  const diffBytes = new Map(corpus.fixture.files.map((file) => [file.id, Buffer.byteLength(file.diff, 'utf8')]));
  return corpus.files
    .map((file, index) => ({ file, index, bytes: diffBytes.get(file.id) ?? 0 }))
    .sort((left, right) => right.bytes - left.bytes || left.index - right.index)
    .map((task) => task.file);
}

function modeledParallelSchedule(
  measurements: readonly ExecutionMeasurement[],
  scheduledFiles: readonly PerformanceCorpusFile[],
  concurrency: number,
): { readonly queueWaitByFile: ReadonlyMap<string, number>; readonly wallMs: number } {
  const availableAt = Array.from({ length: concurrency }, () => 0);
  const measurementsById = new Map(measurements.map((measurement) => [measurement.file.id, measurement]));
  const queueWaitByFile = new Map<string, number>();
  for (const file of scheduledFiles) {
    const measurement = measurementsById.get(file.id);
    if (measurement === undefined) throw new Error(`performance schedule is missing measurement ${file.id}`);
    let worker = 0;
    for (let index = 1; index < availableAt.length; index += 1) {
      if ((availableAt[index] ?? 0) < (availableAt[worker] ?? 0)) worker = index;
    }
    const queueWaitMs = availableAt[worker] ?? 0;
    queueWaitByFile.set(file.id, queueWaitMs);
    availableAt[worker] = queueWaitMs + measurement.modelDurationMs;
  }
  return { queueWaitByFile, wallMs: Math.max(...availableAt) };
}

async function runOne(
  run: number,
  corpus: PerformanceCorpus,
  profile: PerformanceProfile,
  source: PerformanceSource,
  live: LivePerformanceConfiguration | undefined,
): Promise<PerformanceRunSample> {
  const root = await mkdtemp(join(tmpdir(), 'redline-performance-'));
  try {
    const contextBundleStartedAt = Date.now();
    const paths = await materializeBenchmarkFixture(corpus.fixture, root);
    const recording = indexedRecording(corpus);
    const contextPath = join(root, 'code-context.json');
    await writeFile(contextPath, `${JSON.stringify(recording.codeContext, null, 2)}\n`);
    const measuredContextBundleMs = Math.max(0, Date.now() - contextBundleStartedAt);
    const delegate = source === 'recorded'
      ? new RecordedPerformanceExecutor(profile.configuration.harness, recording.responses)
      : live?.executorFactory();
    if (delegate === undefined) throw new Error('live performance execution requires an executor');
    const scheduledFiles = scheduledPerformanceFiles(corpus, profile.configuration.reviewConcurrency);
    const executor = new MeasuringPerformanceExecutor(delegate, corpus.files, source);
    const environment: ReviewEnvironment = {
      harness: profile.configuration.harness,
      reviewDirectory: paths.review,
      sourceDirectory: paths.source,
      outputDirectory: paths.output,
      codeContext: { path: contextPath, repository: recording.codeContext.repository },
      model: source === 'recorded'
        ? {
            provider: profile.configuration.provider,
            endpoint: profile.configuration.endpoint,
            model: profile.configuration.model,
            auth: 'none',
          }
        : live!.model,
      credential: source === 'recorded' ? undefined : live!.credential,
      findingScope: 'defects',
      timeout: source === 'recorded' ? parseDuration('30m') : live!.timeout,
      reviewConcurrency: profile.configuration.reviewConcurrency,
    };
    const boundaries = new Map<string, {
      startedAt: number;
      validatedAt?: number | undefined;
      doneAt?: number | undefined;
    }>();
    const reviewStartedAt = Date.now();
    const result = await runFileReviews({
      environment,
      executor,
      harnessStreamMode: 'off',
      sourceContextStrategy: 'focused-v1',
      onFileStart: ({ path }) => boundaries.set(path, { startedAt: Date.now() }),
      onFileValidated: (recordValue) => {
        const boundary = boundaries.get(recordValue.path);
        if (boundary !== undefined) boundary.validatedAt = Date.now();
      },
      onFileDone: (recordValue) => {
        const boundary = boundaries.get(recordValue.path);
        if (boundary !== undefined) boundary.doneAt = Date.now();
      },
    });
    const reviewFinishedAt = Date.now();
    const measuredReviewWallMs = Math.max(0, reviewFinishedAt - reviewStartedAt);
    const published = await loadPublishedRun(paths.output);
    const publicationStartedAt = Date.now();
    const publication = await publishRecords({
      records: published.records,
      review: published.review,
      publication: {
        token: 'performance-benchmark-token',
        repository: 'benchmark/redline',
        pullRequest: 1,
        head: corpus.fixture.headRevision,
      },
      publisher: new BenchmarkPublisher(),
    });
    const measuredPublicationMs = Math.max(0, Date.now() - publicationStartedAt);
    const publicationMs = source === 'recorded' ? 0 : measuredPublicationMs;
    const baselineExecutor = new MeasuringPerformanceExecutor(
      new RecordedPerformanceExecutor(profile.configuration.harness, recording.responses),
      corpus.files,
      'recorded',
    );
    const baselineResult = await runFileReviews({
      environment: {
        ...environment,
        outputDirectory: join(root, 'baseline-output'),
        credential: undefined,
      },
      executor: baselineExecutor,
      harnessStreamMode: 'off',
      sourceContextStrategy: 'full-files-v1',
    });
    if (
      baselineExecutor.measurements.length !== corpus.files.length
      || baselineResult.records.length !== corpus.files.length
    ) {
      throw new Error('performance baseline did not produce one execution and record per corpus file');
    }
    const baselineMeasurementsById = new Map(
      baselineExecutor.measurements.map((measurement) => [measurement.file.id, measurement]),
    );
    if (executor.measurements.length !== corpus.files.length || result.records.length !== corpus.files.length) {
      throw new Error('performance run did not produce one execution and record per corpus file');
    }
    const recordsById = new Map(result.records.map((recordValue) => [recordValue.fileId, recordValue]));
    const measurementsById = new Map(executor.measurements.map((measurement) => [measurement.file.id, measurement]));
    const modeledSchedule = modeledParallelSchedule(
      executor.measurements,
      scheduledFiles,
      profile.configuration.reviewConcurrency,
    );
    const files = corpus.files.map((file): PerformanceFileSample => {
      const measurement = measurementsById.get(file.id);
      const baselineMeasurement = baselineMeasurementsById.get(file.id);
      const recordValue = recordsById.get(file.id);
      if (measurement === undefined || baselineMeasurement === undefined || recordValue === undefined) {
        throw new Error(`performance run is missing record or measurement ${file.id}`);
      }
      return {
        fileId: file.id,
        path: file.path,
        category: file.category,
        status: measurement.status,
        outcome: recordValue.outcome,
        errorKind: recordValue.errorKind ?? null,
        queueWaitMs: source === 'recorded'
          ? modeledSchedule.queueWaitByFile.get(file.id) ?? 0
          : measurement.queueWaitMs,
        modelDurationMs: measurement.modelDurationMs,
        promptBytes: measurement.promptBytes,
        baselinePromptBytes: baselineMeasurement.promptBytes,
        promptReductionBytes: baselineMeasurement.promptBytes - measurement.promptBytes,
        promptReductionPercent: reductionPercent(baselineMeasurement.promptBytes, measurement.promptBytes),
        estimatedInputTokens: measurement.estimatedInputTokens,
        baselineEstimatedInputTokens: baselineMeasurement.estimatedInputTokens,
        estimatedInputTokenReduction: baselineMeasurement.estimatedInputTokens - measurement.estimatedInputTokens,
        estimatedOutputTokens: measurement.estimatedOutputTokens,
        processStartupMs: measurement.processStartupMs,
        timeToFirstTextMs: measurement.timeToFirstTextMs,
        stdoutBytes: measurement.stdoutBytes,
        stderrBytes: measurement.stderrBytes,
        stdoutTruncated: measurement.stdoutTruncated,
        stderrTruncated: measurement.stderrTruncated,
      };
    });
    const modeledReviewMs = files.reduce((total, file) => total + file.modelDurationMs, 0);
    const measured = (value: number): number => source === 'recorded' ? 0 : Math.max(0, value);
    let filePreparationMs = 0;
    let validationMs = 0;
    let writingMs = 0;
    for (const measurement of executor.measurements) {
      const boundary = boundaries.get(measurement.file.path);
      if (boundary === undefined || boundary.validatedAt === undefined || boundary.doneAt === undefined) {
        throw new Error(`performance run is missing stage boundaries for ${measurement.file.path}`);
      }
      filePreparationMs += measured(measurement.wallStartedAt - boundary.startedAt);
      validationMs += measured(boundary.validatedAt - measurement.wallFinishedAt);
      writingMs += measured(boundary.doneAt - boundary.validatedAt);
    }
    const reviewBundleLoadMs = executor.prepareStartedAt === null
      ? 0
      : measured(executor.prepareStartedAt - reviewStartedAt);
    const harnessPreparationMs = executor.prepareStartedAt === null || executor.prepareFinishedAt === null
      ? 0
      : measured(executor.prepareFinishedAt - executor.prepareStartedAt);
    const lastDoneAt = Math.max(...[...boundaries.values()].map((boundary) => boundary.doneAt ?? reviewFinishedAt));
    const summaryWritingMs = measured(reviewFinishedAt - lastDoneAt);
    const reviewWallMs = source === 'recorded' ? modeledSchedule.wallMs : measuredReviewWallMs;
    return {
      run,
      reviewConcurrency: profile.configuration.reviewConcurrency,
      maximumActiveModelCalls: source === 'recorded'
        ? Math.min(profile.configuration.reviewConcurrency, files.length)
        : executor.maximumActiveCalls,
      reviewWallMs,
      totalModelWorkMs: modeledReviewMs,
      stages: {
        checkoutFetchMs: null,
        runtimeSetupInstallMs: null,
        contextBundleBuildMs: measured(measuredContextBundleMs),
        reviewBundleLoadMs,
        harnessPreparationMs,
        filePreparationMs,
        modelMs: modeledReviewMs,
        validationMs,
        writingMs,
        summaryWritingMs,
        publicationMs,
      },
      modeledReviewMs,
      publicationMs,
      promptBytes: files.reduce((total, file) => total + file.promptBytes, 0),
      baselinePromptBytes: files.reduce((total, file) => total + file.baselinePromptBytes, 0),
      promptReductionBytes: files.reduce((total, file) => total + file.promptReductionBytes, 0),
      promptReductionPercent: reductionPercent(
        files.reduce((total, file) => total + file.baselinePromptBytes, 0),
        files.reduce((total, file) => total + file.promptBytes, 0),
      ),
      medianPromptReductionBytes: median(files.map((file) => file.promptReductionBytes)),
      medianPromptReductionPercent: median(files.map((file) => file.promptReductionPercent)),
      estimatedInputTokens: files.reduce((total, file) => total + file.estimatedInputTokens, 0),
      baselineEstimatedInputTokens: files.reduce(
        (total, file) => total + file.baselineEstimatedInputTokens,
        0,
      ),
      estimatedInputTokenReduction: files.reduce(
        (total, file) => total + file.estimatedInputTokenReduction,
        0,
      ),
      estimatedOutputTokens: files.reduce((total, file) => total + file.estimatedOutputTokens, 0),
      actualInputTokens: null,
      actualOutputTokens: null,
      costUsd: null,
      reviewedFiles: result.records.length,
      omittedFiles: result.records.filter((recordValue) => recordValue.outcome === 'omitted').length,
      invalidFiles: result.records.filter((recordValue) => recordValue.errorKind === 'invalid-output').length,
      findings: result.records.reduce((total, recordValue) => total + recordValue.findings.length, 0),
      rejectedCandidates: result.records.reduce((total, recordValue) => total + recordValue.rejectedCandidates.length, 0),
      coverageComplete: result.review.coverage.files.status === 'completed',
      publicationComplete: publication.failedFileReviews === 0 && publication.summaryCommentId > 0,
      files,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error('cannot calculate a percentile without samples');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] as number;
}

function distribution(values: readonly number[]): Distribution {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maximumMs: Math.max(...values),
  };
}

function indexDuration(sample: IndexSample): number {
  return sample.installationMs
    + sample.restoreMs
    + sample.indexMs
    + sample.queryMs
    + (sample.saveMs ?? 0);
}

function nonReviewDuration(sample: IndexSample): number {
  return sample.checkoutFetchMs
    + sample.runtimeSetupMs
    + sample.dependencyInstallBuildMs
    + sample.harnessInstallMs
    + sample.contextBundleMs
    + sample.publicationMs
    + sample.otherMs
    + indexDuration(sample);
}

function categoryCounts(files: readonly PerformanceCorpusFile[]): Readonly<Record<PerformanceFileCategory, number>> {
  return Object.fromEntries(files.map((file) => file.category).map((category) => [
    category,
    files.filter((file) => file.category === category).length,
  ])) as Readonly<Record<PerformanceFileCategory, number>>;
}

function qualityGate(runs: readonly PerformanceRunSample[], requiredFiles: number): PerformanceQualityGate {
  const reviewedFiles = runs.reduce((total, run) => total + run.reviewedFiles, 0);
  const omittedFiles = runs.reduce((total, run) => total + run.omittedFiles, 0);
  const invalidFiles = runs.reduce((total, run) => total + run.invalidFiles, 0);
  const findingsOnCleanCorpus = runs.reduce((total, run) => total + run.findings, 0);
  const rejectedCandidates = runs.reduce((total, run) => total + run.rejectedCandidates, 0);
  const incompleteCoverageRuns = runs.filter((run) => !run.coverageComplete).length;
  const incompletePublicationRuns = runs.filter((run) => !run.publicationComplete).length;
  return {
    passed: reviewedFiles === requiredFiles * runs.length
      && omittedFiles === 0
      && invalidFiles === 0
      && findingsOnCleanCorpus === 0
      && rejectedCandidates === 0
      && incompleteCoverageRuns === 0
      && incompletePublicationRuns === 0,
    requiredFiles,
    reviewedFiles,
    omittedFiles,
    invalidFiles,
    findingsOnCleanCorpus,
    rejectedCandidates,
    incompleteCoverageRuns,
    incompletePublicationRuns,
  };
}

function conditionResults(
  profile: PerformanceProfile,
  source: PerformanceSource,
  runs: readonly PerformanceRunSample[],
  quality: PerformanceQualityGate,
): readonly PerformanceConditionResult[] {
  return profile.conditions.map((condition) => {
    const indexDurations = condition.samples.map(indexDuration);
    const workflowDurations = condition.samples.map(nonReviewDuration);
    const endToEnd = runs.flatMap((run) => workflowDurations.map((workflowMs) =>
      workflowMs + run.reviewWallMs));
    const values = distribution(endToEnd);
    const targetMs = condition.id === 'warm-index'
      ? profile.targets.warmIndexP95Ms
      : profile.targets.coldIndexP95Ms;
    const sloEligible = source === 'live'
      && runs.length >= profile.targets.minimumLiveCorpusRuns
      && quality.passed;
    const withinTarget = values.p95Ms <= targetMs;
    return {
      id: condition.id,
      cache: condition.cache,
      targetMs,
      withinTarget,
      sloEligible,
      sloPassed: sloEligible ? withinTarget : null,
      indexSamples: indexDurations.length,
      indexP50Ms: percentile(indexDurations, 0.5),
      indexP95Ms: percentile(indexDurations, 0.95),
      stageP50Ms: {
        checkoutFetch: percentile(condition.samples.map((sample) => sample.checkoutFetchMs), 0.5),
        runtimeSetup: percentile(condition.samples.map((sample) => sample.runtimeSetupMs), 0.5),
        indexInstallation: percentile(condition.samples.map((sample) => sample.installationMs), 0.5),
        indexRestore: percentile(condition.samples.map((sample) => sample.restoreMs), 0.5),
        indexBuild: percentile(condition.samples.map((sample) => sample.indexMs), 0.5),
        indexQuery: percentile(condition.samples.map((sample) => sample.queryMs), 0.5),
        indexSave: percentile(condition.samples.map((sample) => sample.saveMs ?? 0), 0.5),
        dependencyInstallBuild: percentile(
          condition.samples.map((sample) => sample.dependencyInstallBuildMs), 0.5,
        ),
        harnessInstall: percentile(condition.samples.map((sample) => sample.harnessInstallMs), 0.5),
        contextBundle: percentile(condition.samples.map((sample) => sample.contextBundleMs), 0.5),
        reviewValidationWriting: percentile(
          condition.samples.map((sample) => sample.reviewValidationWritingMs), 0.5,
        ),
        publication: percentile(condition.samples.map((sample) => sample.publicationMs), 0.5),
        other: percentile(condition.samples.map((sample) => sample.otherMs), 0.5),
      },
      ...values,
    };
  });
}

export async function runPerformanceBenchmark(options: RunPerformanceOptions): Promise<PerformanceReport> {
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > MAX_RUNS) {
    throw new Error(`performance runs must be an integer from 1 through ${MAX_RUNS}`);
  }
  const [corpus, profile] = await Promise.all([
    loadPerformanceCorpus(options.corpusPath),
    loadPerformanceProfile(options.profilePath),
  ]);
  if (options.source === 'live') {
    if (options.live === undefined) throw new Error('live performance execution requires live configuration');
    const expected = profile.configuration;
    if (options.live.harness !== expected.harness
      || options.live.model.provider !== expected.provider
      || options.live.model.endpoint !== expected.endpoint
      || options.live.model.model !== expected.model) {
      throw new Error('live performance configuration does not match the pinned profile');
    }
  }
  const runs: PerformanceRunSample[] = [];
  for (let run = 1; run <= options.runs; run += 1) {
    runs.push(await runOne(run, corpus, profile, options.source, options.live));
  }
  const quality = qualityGate(runs, corpus.files.length);
  return {
    version: PERFORMANCE_REPORT_VERSION,
    kind: 'review-performance',
    source: options.source,
    createdAt: options.source === 'live' ? (options.now ?? (() => new Date()))().toISOString() : null,
    corpus: {
      id: corpus.id,
      title: corpus.title,
      files: corpus.files.length,
      categories: categoryCounts(corpus.files),
    },
    profile: {
      id: profile.id,
      harness: profile.configuration.harness,
      provider: profile.configuration.provider,
      model: profile.configuration.model,
      indexProvider: profile.configuration.indexProvider,
      indexProviderVersion: profile.configuration.indexProviderVersion,
      execution: profile.configuration.execution,
      reviewConcurrency: profile.configuration.reviewConcurrency,
    },
    targets: profile.targets,
    quality,
    runs,
    conditions: conditionResults(profile, options.source, runs, quality),
    limitations: [
      'Recorded mode uses checked-in model durations, a modeled bounded-worker schedule, and named production workflow timings; it is deterministic fixture evidence, not a live SLO pass.',
      'Live mode measures the fixed review corpus but combines it with checked-in warm/cold non-review stage samples from production Action runs.',
      'The benchmark command starts after checkout and runtime installation, so local run-stage fields for those boundaries are null; production profile samples provide them for end-to-end totals.',
      'Full-file baseline prompts are assembled in a recorded prepass and are excluded from measured review latency; the focused strategy is the executed review path.',
      'Token counts are four-characters-per-token estimates until the selected harness exposes bounded provider usage.',
      'Cost is null until the selected harness exposes bounded provider cost metadata.',
      'The local publication stage uses the forge-neutral service with an in-memory publisher; end-to-end totals use sampled production publication latency.',
    ],
  };
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

export function renderPerformanceMarkdown(report: PerformanceReport): string {
  const lines = [
    '# Review performance benchmark',
    '',
    `- **Source:** ${report.source}`,
    `- **Corpus:** ${report.corpus.title} (${report.corpus.files} files)`,
    `- **Execution:** ${report.profile.execution} (${report.profile.reviewConcurrency} workers)`,
    `- **Harness/model:** ${report.profile.harness} (${report.profile.provider}/${report.profile.model})`,
    `- **Index provider:** ${report.profile.indexProvider} ${report.profile.indexProviderVersion}`,
    `- **Runs:** ${report.runs.length}`,
    `- **Quality gate:** ${report.quality.passed ? 'pass' : 'fail'}`,
    '',
    '## End-to-end targets',
    '',
    '| Condition | Cache | Samples | Index p50 | Index p95 | Total p50 | Total p95 | Maximum | Target | SLO gate |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const condition of report.conditions) {
    lines.push(`| ${condition.id} | ${condition.cache} | ${condition.samples} | ${seconds(condition.indexP50Ms)} | ${seconds(condition.indexP95Ms)} | ${seconds(condition.p50Ms)} | ${seconds(condition.p95Ms)} | ${seconds(condition.maximumMs)} | ${seconds(condition.targetMs)} | ${condition.sloPassed === null ? 'not eligible' : condition.sloPassed ? 'pass' : 'fail'} |`);
  }
  lines.push(
    '',
    '## Production workflow stage medians',
    '',
    '| Condition | Checkout/fetch | Runtime setup | Dependency install/build | Harness install | Context bundle | Validation/writing | Publication | Other bounded overhead |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const condition of report.conditions) {
    const stage = condition.stageP50Ms;
    lines.push(`| ${condition.id} | ${seconds(stage.checkoutFetch)} | ${seconds(stage.runtimeSetup)} | ${seconds(stage.dependencyInstallBuild)} | ${seconds(stage.harnessInstall)} | ${seconds(stage.contextBundle)} | ${seconds(stage.reviewValidationWriting)} | ${seconds(stage.publication)} | ${seconds(stage.other)} |`);
  }
  lines.push(
    '',
    '## Index stage medians',
    '',
    '| Condition | Provider installation | Cache restore | Index build | Query/export | Cache save |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const condition of report.conditions) {
    const stage = condition.stageP50Ms;
    lines.push(`| ${condition.id} | ${seconds(stage.indexInstallation)} | ${seconds(stage.indexRestore)} | ${seconds(stage.indexBuild)} | ${seconds(stage.indexQuery)} | ${seconds(stage.indexSave)} |`);
  }
  lines.push(
    '',
    '## Coverage and validity',
    '',
    `- Required files per run: ${report.quality.requiredFiles}`,
    `- Reviewed records: ${report.quality.reviewedFiles}`,
    `- Omitted records: ${report.quality.omittedFiles}`,
    `- Invalid records: ${report.quality.invalidFiles}`,
    `- Findings on clean corpus: ${report.quality.findingsOnCleanCorpus}`,
    `- Rejected candidates: ${report.quality.rejectedCandidates}`,
    `- Runs with incomplete required coverage: ${report.quality.incompleteCoverageRuns}`,
    `- Runs with incomplete publication: ${report.quality.incompletePublicationRuns}`,
    '',
    '## Runs',
    '',
    '| Run | Review wall | Total model work | Max active calls | Publication | Full prompt bytes | Focused prompt bytes | Aggregate reduction | Median reduction | Est. input tokens full | Est. input tokens focused | Est. token reduction | Est. output tokens | Omitted | Findings |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const run of report.runs) {
    lines.push(`| ${run.run} | ${seconds(run.reviewWallMs)} | ${seconds(run.totalModelWorkMs)} | ${run.maximumActiveModelCalls} | ${seconds(run.publicationMs)} | ${run.baselinePromptBytes} | ${run.promptBytes} | ${run.promptReductionBytes} (${run.promptReductionPercent.toFixed(2)}%) | ${run.medianPromptReductionBytes} (${run.medianPromptReductionPercent.toFixed(2)}%) | ${run.baselineEstimatedInputTokens} | ${run.estimatedInputTokens} | ${run.estimatedInputTokenReduction} | ${run.estimatedOutputTokens} | ${run.omittedFiles} | ${run.findings} |`);
  }
  lines.push(
    '',
    '## Measured benchmark stages',
    '',
    '| Run | Context build | Bundle load | Harness prepare | File prepare | Total model work | Validation | Writing | Summary writing | Publication |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const run of report.runs) {
    const stage = run.stages;
    lines.push(`| ${run.run} | ${seconds(stage.contextBundleBuildMs)} | ${seconds(stage.reviewBundleLoadMs)} | ${seconds(stage.harnessPreparationMs)} | ${seconds(stage.filePreparationMs)} | ${seconds(stage.modelMs)} | ${seconds(stage.validationMs)} | ${seconds(stage.writingMs)} | ${seconds(stage.summaryWritingMs)} | ${seconds(stage.publicationMs)} |`);
  }
  const first = report.runs[0];
  if (first !== undefined) {
    lines.push(
      '',
      '## Per-file prompt volume',
      '',
      '| File | Category | Queue wait | Model | First text | Full bytes | Focused bytes | Reduction | Est. tokens full | Est. tokens focused | Output bytes | Outcome |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    );
    for (const file of first.files) {
      lines.push(`| ${file.path} | ${file.category} | ${seconds(file.queueWaitMs)} | ${seconds(file.modelDurationMs)} | ${file.timeToFirstTextMs === null ? 'n/a' : seconds(file.timeToFirstTextMs)} | ${file.baselinePromptBytes} | ${file.promptBytes} | ${file.promptReductionBytes} (${file.promptReductionPercent.toFixed(2)}%) | ${file.baselineEstimatedInputTokens} | ${file.estimatedInputTokens} | ${file.stdoutBytes} | ${file.outcome} |`);
    }
  }
  lines.push('', '## Limitations', '', ...report.limitations.map((item) => `- ${item}`), '');
  return `${lines.join('\n')}\n`;
}

async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writePerformanceReport(
  report: PerformanceReport,
  outputDirectory: string,
): Promise<void> {
  const root = resolve(outputDirectory);
  await Promise.all([
    writeAtomic(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, report.source === 'live' ? 0o600 : undefined),
    writeAtomic(join(root, 'report.md'), renderPerformanceMarkdown(report), report.source === 'live' ? 0o600 : undefined),
  ]);
}
