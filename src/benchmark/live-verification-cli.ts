#!/usr/bin/env node
/** Opt-in live quality/latency capture. Discovery is replayed byte-for-byte
 * into the verifier so discovery variance cannot masquerade as verification. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBenchmarkCorpus, materializeBenchmarkFixture, type FixtureRecording } from './benchmark.js';
import { parseDuration } from '../duration.js';
import { createHarnessExecutor, isHarnessName } from '../harness-executor/registry.js';
import type { HarnessExecuteOptions, HarnessExecutor, HarnessPrompt, HarnessRun, HarnessSettings, PreparedHarness } from '../harness-executor/types.js';
import { parseModelConfig, selectModelCredential, type ReviewEnvironment } from '../review/environment.js';
import { runFileReviews } from '../review/runner.js';
import { VERIFICATION_PROMPT_ID } from '../review/verification-prompt.js';
import type { FileReviewRecord } from '../review/types.js';

interface Configuration {
  readonly harness: 'pi' | 'opencode';
  readonly model: ReviewEnvironment['model'];
  readonly credential: ReviewEnvironment['credential'];
  readonly timeout: ReviewEnvironment['timeout'];
}

function configuration(env: NodeJS.ProcessEnv): Configuration {
  if (env.REDLINE_LIVE_BENCHMARK !== '1') throw new Error('set REDLINE_LIVE_BENCHMARK=1 for opt-in live model evaluation');
  const harness = env.REDLINE_HARNESS ?? '';
  if (!isHarnessName(harness) || harness === 'echo') throw new Error('select pi or opencode for a live verification capture');
  const model = parseModelConfig(env.REDLINE_MODEL_CONFIG ?? '');
  return { harness, model, credential: selectModelCredential(model, env.REDLINE_MODEL_AUTH ?? ''),
    timeout: parseDuration(env.REDLINE_TIMEOUT ?? '30m') };
}

class ReplayDiscoveryExecutor implements HarnessExecutor {
  readonly harness: HarnessExecutor['harness'];
  readonly discovery: HarnessRun[] = [];
  phase: 'discovery' | 'verification' = 'discovery';
  discoveryPromptBytes = 0;
  verificationPromptBytes = 0;
  verificationCalls = 0;
  #replayOffset = 0;

  constructor(private readonly delegate: HarnessExecutor) {
    this.harness = delegate.harness;
  }

  prepare(settings: HarnessSettings): Promise<PreparedHarness> { return this.delegate.prepare(settings); }

  async execute(prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun> {
    const bytes = Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
    if (this.phase === 'discovery') {
      this.discoveryPromptBytes += bytes;
      const result = await this.delegate.execute(prepared, prompt, options);
      this.discovery.push(result);
      return result;
    }
    if (!prompt.system.includes(`"policyId": "${VERIFICATION_PROMPT_ID}"`)) {
      const result = this.discovery[this.#replayOffset++];
      if (result === undefined) throw new Error('verifier replay consumed more discovery outputs than were captured');
      // No second discovery model call. Only verifier durations are incremental.
      return { ...result, durationMs: 0 };
    }
    this.verificationCalls += 1;
    this.verificationPromptBytes += bytes;
    return this.delegate.execute(prepared, prompt, options);
  }

  assertCompleteReplay(): void {
    if (this.#replayOffset !== this.discovery.length) throw new Error('verifier replay omitted a captured discovery file');
  }
}

function persisted(records: readonly FileReviewRecord[]): readonly FileReviewRecord[] {
  return records.map((record) => {
    const { rawModelOutput: _raw, verificationArtifact: _verification, followUpArtifact: _followUp, ...safe } = record as FileReviewRecord & {
      readonly rawModelOutput?: string | undefined;
      readonly verificationArtifact?: unknown;
      readonly followUpArtifact?: unknown;
    };
    return safe;
  });
}

async function captureCase(
  fixture: Awaited<ReturnType<typeof loadBenchmarkCorpus>>['fixtures'][number],
  recording: FixtureRecording,
  conf: Configuration,
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), `redline-live-verification-${fixture.id}-`));
  try {
    const paths = await materializeBenchmarkFixture(fixture, root);
    const executor = new ReplayDiscoveryExecutor(createHarnessExecutor(conf.harness));
    let codeContext: ReviewEnvironment['codeContext'];
    if (recording.mode !== 'file-only') {
      const path = join(root, 'code-context.json');
      await writeFile(path, JSON.stringify(recording.codeContext));
      codeContext = { path, repository: recording.codeContext.repository };
    }
    const environment: ReviewEnvironment = {
      harness: conf.harness, model: conf.model, credential: conf.credential,
      findingScope: 'defects', timeout: conf.timeout, reviewConcurrency: 1, codeContext,
      reviewDirectory: paths.review, sourceDirectory: paths.source, outputDirectory: paths.output,
    };
    const discovery = await runFileReviews({ environment, executor });
    executor.phase = 'verification';
    const verified = await runFileReviews({ environment: {
      ...environment, outputDirectory: join(root, 'verified'),
    }, executor, verifyCandidates: true });
    executor.assertCompleteReplay();
    process.stderr.write(`live verification: ${fixture.id}/${recording.mode} discovery ${discovery.summary.findings}; verified ${verified.summary.findings}\n`);
    return {
      fixtureId: fixture.id, mode: recording.mode,
      discovery: { exitCode: discovery.exitCode, promptBytes: executor.discoveryPromptBytes,
        durationMs: discovery.records.reduce((sum, item) => sum + item.durationMs, 0),
        records: persisted(discovery.records) },
      verified: { exitCode: verified.exitCode, promptBytes: executor.verificationPromptBytes,
        verifierCalls: executor.verificationCalls,
        durationMs: verified.records.reduce((sum, item) => sum + item.durationMs, 0),
        records: persisted(verified.records), coverage: verified.review.coverage,
        synthesis: verified.review.synthesis, verdict: verified.review.verdict },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  try {
    const args = process.argv.slice(2);
    let outputArgument: string | undefined;
    let corpusDirectory = 'benchmark/review-quality/verification-v1';
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if ((key !== '--output' && key !== '--corpus') || value === undefined || value.length === 0) {
        throw new Error('usage: live-verification-cli --output <private-capture.json> [--corpus <fixture-directory>]');
      }
      if (key === '--output') outputArgument = value;
      else corpusDirectory = value;
    }
    if (outputArgument === undefined) throw new Error('--output is required');
    const conf = configuration(process.env);
    const corpus = await loadBenchmarkCorpus(resolve(corpusDirectory));
    const cases: Record<string, unknown>[] = [];
    for (const fixture of corpus.fixtures) {
      for (const recording of fixture.recordings) {
        cases.push(await captureCase(fixture, recording, conf));
      }
    }
    const output = resolve(outputArgument);
    await mkdir(dirname(output), { recursive: true });
    const temp = `${output}.tmp-${randomUUID()}`;
    const artifact = { version: 1, kind: 'live-verification-replay', createdAt: new Date().toISOString(),
      harness: conf.harness, provider: conf.model.provider, model: conf.model.model,
      corpusVersion: corpus.version, cases };
    try {
      await writeFile(temp, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temp, output);
    } finally {
      await rm(temp, { force: true });
    }
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`redline-live-verification: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await main();
