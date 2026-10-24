#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadBenchmarkCorpus,
  materializeBenchmarkFixture,
  type BenchmarkMode,
  type FixtureRecording,
} from './benchmark.ts';
import { parseDuration, type Duration } from '../duration.ts';
import { createHarnessExecutor, isHarnessName } from '../harness-executor/registry.ts';
import type {
  HarnessExecuteOptions,
  HarnessExecutor,
  HarnessPrompt,
  HarnessRun,
  HarnessSettings,
  PreparedHarness,
} from '../harness-executor/types.ts';
import {
  parseModelConfig,
  selectModelCredential,
  type ReviewEnvironment,
} from '../review/environment.ts';
import { runFileReviews } from '../review/runner.ts';
import { FINDING_SCOPES, type FileReviewRecord, type FindingScope, type ReviewRunSummary } from '../review/types.ts';

const LIVE_CAPTURE_VERSION = 1 as const;

interface LiveOptions {
  readonly corpusDirectory: string;
  readonly outputFile: string;
}

interface LiveConfiguration {
  readonly harness: 'pi' | 'opencode';
  readonly model: ReviewEnvironment['model'];
  readonly credential: ReviewEnvironment['credential'];
  readonly findingScope: FindingScope;
  readonly timeout: Duration;
}

interface LiveCaseCapture {
  readonly fixtureId: string;
  readonly mode: BenchmarkMode;
  readonly exitCode: number;
  readonly promptBytes: number;
  readonly reviewDurationMs: number;
  readonly indexedContextSource: 'disabled' | 'checked-in-recording';
  readonly summary: ReviewRunSummary;
  readonly records: readonly FileReviewRecord[];
}

interface LiveModelCapture {
  readonly version: typeof LIVE_CAPTURE_VERSION;
  readonly corpusVersion: number;
  readonly kind: 'live-model';
  readonly createdAt: string;
  readonly harness: 'pi' | 'opencode';
  readonly provider: string;
  readonly model: string;
  readonly cases: readonly LiveCaseCapture[];
}

class MeasuringExecutor implements HarnessExecutor {
  readonly harness: HarnessExecutor['harness'];
  readonly #delegate: HarnessExecutor;
  promptBytes = 0;

  constructor(delegate: HarnessExecutor) {
    this.#delegate = delegate;
    this.harness = delegate.harness;
  }

  prepare(settings: HarnessSettings): Promise<PreparedHarness> {
    return this.#delegate.prepare(settings);
  }

  execute(prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun> {
    this.promptBytes += Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
    return this.#delegate.execute(prepared, prompt, options);
  }
}

function parseArguments(args: readonly string[]): LiveOptions {
  let corpusDirectory = 'benchmark/review-quality/v2';
  let outputFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--corpus' && argument !== '--output') {
      throw new Error(`unsupported argument: ${argument ?? ''}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
    if (argument === '--corpus') corpusDirectory = value;
    else outputFile = value;
    index += 1;
  }
  if (outputFile === undefined) throw new Error('--output is required for live captures');
  return { corpusDirectory: resolve(corpusDirectory), outputFile: resolve(outputFile) };
}

function parseConfiguration(environment: NodeJS.ProcessEnv): LiveConfiguration {
  if (environment.REDLINE_LIVE_BENCHMARK !== '1') {
    throw new Error('set REDLINE_LIVE_BENCHMARK=1 to run live model evaluation');
  }
  const harness = environment.REDLINE_HARNESS ?? '';
  if (!isHarnessName(harness) || harness === 'echo') {
    throw new Error('REDLINE_HARNESS must select pi or opencode for live model evaluation');
  }
  const model = parseModelConfig(environment.REDLINE_MODEL_CONFIG ?? '');
  const credential = selectModelCredential(model, environment.REDLINE_MODEL_AUTH ?? '');
  const findingScope = environment.REDLINE_FINDING_SCOPE ?? 'defects';
  if (!(FINDING_SCOPES as readonly string[]).includes(findingScope)) {
    throw new Error('REDLINE_FINDING_SCOPE is unsupported');
  }
  return {
    harness,
    model,
    credential,
    findingScope: findingScope as FindingScope,
    timeout: parseDuration(environment.REDLINE_TIMEOUT ?? '30m'),
  };
}

async function writeContext(root: string, recording: FixtureRecording): Promise<ReviewEnvironment['codeContext']> {
  if (recording.mode === 'file-only') return undefined;
  const path = join(root, 'code-context.json');
  await writeFile(path, `${JSON.stringify(recording.codeContext, null, 2)}\n`);
  return { path, repository: recording.codeContext.repository };
}

function withoutRawModelOutput(records: readonly FileReviewRecord[]): readonly FileReviewRecord[] {
  return records.map((record) => {
    const { rawModelOutput: _rawModelOutput, ...persisted } = record as FileReviewRecord & {
      readonly rawModelOutput?: string | undefined;
    };
    return persisted;
  });
}

async function captureCase(
  fixture: Awaited<ReturnType<typeof loadBenchmarkCorpus>>['fixtures'][number],
  recording: FixtureRecording,
  configuration: LiveConfiguration,
): Promise<LiveCaseCapture> {
  const root = await mkdtemp(join(tmpdir(), `redline-live-benchmark-${fixture.id}-`));
  try {
    const paths = await materializeBenchmarkFixture(fixture, root);
    const executor = new MeasuringExecutor(createHarnessExecutor(configuration.harness));
    const environment: ReviewEnvironment = {
      harness: configuration.harness,
      reviewDirectory: paths.review,
      sourceDirectory: paths.source,
      outputDirectory: paths.output,
      codeContext: await writeContext(root, recording),
      model: configuration.model,
      credential: configuration.credential,
      findingScope: configuration.findingScope,
      timeout: configuration.timeout,
      runTimeout: configuration.timeout,
      reviewConcurrency: 1,
    };
    const result = await runFileReviews({ environment, executor });
    return {
      fixtureId: fixture.id,
      mode: recording.mode,
      exitCode: result.exitCode,
      promptBytes: executor.promptBytes,
      reviewDurationMs: result.records.reduce((total, record) => total + record.durationMs, 0),
      indexedContextSource: recording.mode === 'file-only' ? 'disabled' : 'checked-in-recording',
      summary: result.summary,
      records: withoutRawModelOutput(result.records),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runLiveModelCapture(
  corpusDirectory: string,
  configuration: LiveConfiguration,
): Promise<LiveModelCapture> {
  const corpus = await loadBenchmarkCorpus(corpusDirectory);
  const cases: LiveCaseCapture[] = [];
  for (const fixture of corpus.fixtures) {
    for (const recording of fixture.recordings) {
      cases.push(await captureCase(fixture, recording, configuration));
    }
  }
  return {
    version: LIVE_CAPTURE_VERSION,
    corpusVersion: corpus.version,
    kind: 'live-model',
    createdAt: new Date().toISOString(),
    harness: configuration.harness,
    provider: configuration.model.provider,
    model: configuration.model.model,
    cases,
  };
}

async function writeCapture(path: string, capture: LiveModelCapture): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(capture, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const options = parseArguments(args);
    const configuration = parseConfiguration(environment);
    const capture = await runLiveModelCapture(options.corpusDirectory, configuration);
    await writeCapture(options.outputFile, capture);
    process.stdout.write(`${options.outputFile}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`redline-live-benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await main();
