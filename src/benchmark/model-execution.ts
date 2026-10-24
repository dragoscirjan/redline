import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  loadBenchmarkCorpus,
  materializeBenchmarkFixture,
  type BenchmarkFixture,
} from './benchmark.ts';
import { parseDuration } from '../duration.ts';
import {
  createPiExecutor,
  type PiStructuredOutput,
  type PiThinkingLevel,
} from '../harness-executor/pi-executor.ts';
import type {
  HarnessExecuteOptions,
  HarnessExecutor,
  HarnessPrompt,
  HarnessRun,
  HarnessSettings,
  HarnessUsageTelemetry,
  PreparedHarness,
} from '../harness-executor/types.ts';
import type { ReviewEnvironment } from '../review/environment.ts';
import { runFileReviews } from '../review/runner.ts';
import type { FileReviewErrorKind, FileReviewOutcome, FileReviewRecord, FindingSide } from '../review/types.ts';

export const MODEL_EXECUTION_CAPTURE_VERSION = 1 as const;
export const MODEL_EXECUTION_REPORT_VERSION = 1 as const;

export interface ModelExecutionMode {
  readonly id: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly maxOutputTokens: number;
  readonly structuredOutput: PiStructuredOutput;
  readonly productionEligible: boolean;
}

export const MODEL_EXECUTION_MODES: readonly ModelExecutionMode[] = [
  {
    id: 'off-4096', thinkingLevel: 'off', maxOutputTokens: 4_096,
    structuredOutput: 'none', productionEligible: true,
  },
  {
    id: 'minimal-4096', thinkingLevel: 'minimal', maxOutputTokens: 4_096,
    structuredOutput: 'none', productionEligible: true,
  },
  {
    id: 'low-4096', thinkingLevel: 'low', maxOutputTokens: 4_096,
    structuredOutput: 'none', productionEligible: true,
  },
  {
    id: 'off-16384', thinkingLevel: 'off', maxOutputTokens: 16_384,
    structuredOutput: 'none', productionEligible: true,
  },
  {
    id: 'off-4096-json', thinkingLevel: 'off', maxOutputTokens: 4_096,
    structuredOutput: 'json-object', productionEligible: false,
  },
] as const;

export interface ModelTokenPricing {
  readonly inputUsdPerToken: number;
  readonly outputUsdPerToken: number;
  readonly cacheReadUsdPerToken: number;
}

export interface ModelExecutionRunTelemetry {
  readonly status: HarnessRun['status'];
  readonly durationMs: number;
  readonly processStartupMs: number | null;
  readonly timeToFirstTextMs: number | null;
  readonly retryCount: number;
  readonly usage: HarnessUsageTelemetry | null;
}

export interface ModelExecutionFindingCapture {
  readonly side: FindingSide;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ModelExecutionRecordCapture {
  readonly fileId: string;
  readonly path: string;
  readonly outcome: FileReviewOutcome;
  readonly errorKind?: FileReviewErrorKind | undefined;
  readonly durationMs: number;
  readonly findings: readonly ModelExecutionFindingCapture[];
}

export interface ModelExecutionCaseCapture {
  readonly fixtureId: string;
  readonly iteration: number;
  readonly wallDurationMs: number;
  readonly promptBytes: number;
  readonly runs: readonly ModelExecutionRunTelemetry[];
  readonly records: readonly ModelExecutionRecordCapture[];
}

export interface ModelExecutionModeCapture extends ModelExecutionMode {
  readonly cases: readonly ModelExecutionCaseCapture[];
}

export interface ModelExecutionCapture {
  readonly version: typeof MODEL_EXECUTION_CAPTURE_VERSION;
  readonly kind: 'live-model-execution';
  readonly corpusVersion: number;
  readonly createdAt: string;
  readonly harness: 'pi';
  readonly provider: string;
  readonly model: string;
  readonly pricing: ModelTokenPricing;
  readonly freshProcessProbe: {
    readonly samples: readonly ModelExecutionRunTelemetry[];
  };
  readonly modes: readonly ModelExecutionModeCapture[];
}

export interface ModelExecutionModeReport extends ModelExecutionMode {
  readonly fixtures: number;
  readonly completeFixtures: number;
  readonly omittedFiles: number;
  readonly expectedIssues: number;
  readonly evidenceLocationCredits: number;
  readonly findings: number;
  readonly falsePositives: number;
  readonly duplicateFindings: number;
  readonly promptBytes: number;
  readonly wallDurationP50Ms: number;
  readonly wallDurationP95Ms: number;
  readonly processStartupP50Ms: number | null;
  readonly processStartupP95Ms: number | null;
  readonly timeToFirstTextP50Ms: number | null;
  readonly timeToFirstTextP95Ms: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly retries: number;
  readonly qualityMaintained: boolean;
}

export interface ModelExecutionReport {
  readonly version: typeof MODEL_EXECUTION_REPORT_VERSION;
  readonly kind: 'model-execution-policy';
  readonly sourceCaptureCreatedAt: string;
  readonly harness: 'pi';
  readonly provider: string;
  readonly model: string;
  readonly corpusVersion: number;
  readonly modes: readonly ModelExecutionModeReport[];
  readonly recommendation: {
    readonly mode: string;
    readonly rationale: readonly string[];
  };
  readonly freshProcessProbe: {
    readonly samples: number;
    readonly successes: number;
    readonly durationP50Ms: number;
    readonly durationP95Ms: number;
    readonly timeToFirstTextP50Ms: number | null;
    readonly timeToFirstTextP95Ms: number | null;
  };
  readonly deadlines: {
    readonly perFileMs: number;
    readonly wholeRunMs: number;
    readonly behavior: string;
  };
  readonly executionModes: readonly {
    readonly mode: 'fresh-process' | 'rpc-worker' | 'direct-sdk';
    readonly status: 'selected' | 'not-selected';
    readonly reason: string;
  }[];
}

class MeasuringExecutor implements HarnessExecutor {
  readonly harness = 'pi' as const;
  readonly #delegate: HarnessExecutor;
  promptBytes = 0;
  readonly runs: ModelExecutionRunTelemetry[] = [];

  constructor(delegate: HarnessExecutor) {
    this.#delegate = delegate;
  }

  prepare(settings: HarnessSettings): Promise<PreparedHarness> {
    return this.#delegate.prepare(settings);
  }

  async execute(
    prepared: PreparedHarness,
    prompt: HarnessPrompt,
    options?: HarnessExecuteOptions,
  ): Promise<HarnessRun> {
    this.promptBytes += Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
    const run = await this.#delegate.execute(prepared, prompt, options);
    this.runs.push({
      status: run.status,
      durationMs: run.durationMs,
      processStartupMs: run.telemetry?.processStartupMs ?? null,
      timeToFirstTextMs: run.telemetry?.timeToFirstTextMs ?? null,
      retryCount: run.telemetry?.retryCount ?? 0,
      usage: run.telemetry?.usage ?? null,
    });
    return run;
  }
}

function persistedRecords(records: readonly FileReviewRecord[]): readonly ModelExecutionRecordCapture[] {
  return records.map((record) => ({
    fileId: record.fileId,
    path: record.path,
    outcome: record.outcome,
    ...(record.errorKind === undefined ? {} : { errorKind: record.errorKind }),
    durationMs: record.durationMs,
    findings: record.findings.map((finding) => ({
      side: finding.side,
      startLine: finding.startLine,
      endLine: finding.endLine,
    })),
  }));
}

async function captureCase(
  fixture: BenchmarkFixture,
  iteration: number,
  mode: ModelExecutionMode,
  model: ReviewEnvironment['model'],
  credential: ReviewEnvironment['credential'],
): Promise<ModelExecutionCaseCapture> {
  const root = await mkdtemp(join(tmpdir(), `redline-model-execution-${mode.id}-${fixture.id}-`));
  try {
    const paths = await materializeBenchmarkFixture(fixture, root);
    const executor = new MeasuringExecutor(createPiExecutor({
      thinkingLevel: mode.thinkingLevel,
      maxOutputTokens: mode.maxOutputTokens,
      temperature: 0,
      structuredOutput: mode.structuredOutput,
      transientRetries: 1,
    }));
    const environment: ReviewEnvironment = {
      harness: 'pi',
      reviewDirectory: paths.review,
      sourceDirectory: paths.source,
      outputDirectory: paths.output,
      codeContext: undefined,
      model,
      credential,
      findingScope: 'defects',
      timeout: parseDuration('4m'),
      runTimeout: parseDuration('10m'),
      reviewConcurrency: 1,
    };
    const startedAt = Date.now();
    const result = await runFileReviews({ environment, executor, harnessStreamMode: 'off' });
    return {
      fixtureId: fixture.id,
      iteration,
      wallDurationMs: Math.max(0, Date.now() - startedAt),
      promptBytes: executor.promptBytes,
      runs: executor.runs,
      records: persistedRecords(result.records),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runFreshProcessProbe(sampleCount = 10): Promise<readonly ModelExecutionRunTelemetry[]> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if ((request.url ?? '').includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model' }] }));
        return;
      }
      let stream = false;
      try {
        stream = (JSON.parse(body) as { stream?: unknown }).stream === true;
      } catch {
        // Pi always sends valid JSON; malformed probe input falls through to a normal response.
      }
      const text = '{"version":4,"fileId":"000001","outcome":"clean","findings":[],"contextRequests":[]}';
      if (stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({
          id: 'probe', object: 'chat.completion.chunk', model: 'probe-model',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'probe', object: 'chat.completion.chunk', model: 'probe-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'probe', object: 'chat.completion', model: 'probe-model',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }));
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fresh-process probe did not bind TCP');
  const workDirectory = await mkdtemp(join(tmpdir(), 'redline-pi-process-probe-'));
  try {
    const executor = createPiExecutor({
      thinkingLevel: 'off', maxOutputTokens: 16_384, temperature: 0, transientRetries: 0,
    });
    const prepared = await executor.prepare({
      model: {
        provider: 'probe', endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: 'probe-model',
      },
      credential: undefined,
      timeoutMs: 30_000,
      workDirectory,
    });
    const samples: ModelExecutionRunTelemetry[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const run = await executor.execute(prepared, {
        system: 'Return the requested JSON object only.',
        user: `Return probe sample ${index}.`,
      }, { streamMode: 'off' });
      samples.push({
        status: run.status,
        durationMs: run.durationMs,
        processStartupMs: run.telemetry?.processStartupMs ?? null,
        timeToFirstTextMs: run.telemetry?.timeToFirstTextMs ?? null,
        retryCount: run.telemetry?.retryCount ?? 0,
        usage: run.telemetry?.usage ?? null,
      });
    }
    return samples;
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
  }
}

export async function captureModelExecution(input: {
  readonly corpusDirectory: string;
  readonly model: ReviewEnvironment['model'];
  readonly credential: ReviewEnvironment['credential'];
  readonly pricing: ModelTokenPricing;
  readonly modes?: readonly ModelExecutionMode[] | undefined;
  readonly repetitions?: number | undefined;
}): Promise<ModelExecutionCapture> {
  const corpus = await loadBenchmarkCorpus(input.corpusDirectory);
  const repetitions = input.repetitions ?? 3;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) {
    throw new Error('model execution repetitions must be an integer from 1 through 5');
  }
  const modeCaptures: ModelExecutionModeCapture[] = [];
  for (const mode of input.modes ?? MODEL_EXECUTION_MODES) {
    const cases: ModelExecutionCaseCapture[] = [];
    for (let iteration = 1; iteration <= repetitions; iteration += 1) {
      for (const fixture of corpus.fixtures) {
        cases.push(await captureCase(fixture, iteration, mode, input.model, input.credential));
      }
    }
    modeCaptures.push({ ...mode, cases });
  }
  const freshProcessProbe = { samples: await runFreshProcessProbe() };
  return {
    version: MODEL_EXECUTION_CAPTURE_VERSION,
    kind: 'live-model-execution',
    corpusVersion: corpus.version,
    createdAt: new Date().toISOString(),
    harness: 'pi',
    provider: input.model.provider,
    model: input.model.model,
    pricing: input.pricing,
    freshProcessProbe,
    modes: modeCaptures,
  };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function nullablePercentile(values: readonly (number | null)[], quantile: number): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : percentile(present, quantile);
}

function findingMatches(
  finding: ModelExecutionFindingCapture,
  record: ModelExecutionRecordCapture,
  fixture: BenchmarkFixture,
): string | null {
  for (const issue of fixture.expectedIssues) {
    if (issue.locations.some((location) => location.path === record.path
      && location.side === finding.side
      && finding.startLine >= location.startLine
      && finding.endLine <= location.endLine)) {
      return issue.id;
    }
  }
  return null;
}

function sumNullable(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

function scoreMode(
  mode: ModelExecutionModeCapture,
  fixtures: readonly BenchmarkFixture[],
  pricing: ModelTokenPricing,
): Omit<ModelExecutionModeReport, 'qualityMaintained'> {
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  let expectedIssues = 0;
  let evidenceLocationCredits = 0;
  let findings = 0;
  let falsePositives = 0;
  let duplicateFindings = 0;
  let completeFixtures = 0;
  let omittedFiles = 0;
  const credited = new Set<string>();
  const runs = mode.cases.flatMap((item) => item.runs);

  for (const item of mode.cases) {
    const fixture = fixtureById.get(item.fixtureId);
    if (fixture === undefined) throw new Error(`model execution capture references unknown fixture ${item.fixtureId}`);
    expectedIssues += fixture.expectedIssues.length;
    if (item.records.every((record) => record.outcome === 'clean' || record.outcome === 'findings')) completeFixtures += 1;
    omittedFiles += item.records.filter((record) => record.outcome === 'omitted').length;
    for (const record of item.records) {
      for (const finding of record.findings) {
        findings += 1;
        const issueId = findingMatches(finding, record, fixture);
        if (issueId === null) {
          falsePositives += 1;
          continue;
        }
        const key = `${item.iteration}:${fixture.id}:${issueId}`;
        if (credited.has(key)) duplicateFindings += 1;
        else {
          credited.add(key);
          evidenceLocationCredits += 1;
        }
      }
    }
  }

  const inputTokens = sumNullable(runs.map((run) => run.usage?.inputTokens ?? null));
  const outputTokens = sumNullable(runs.map((run) => run.usage?.outputTokens ?? null));
  const cacheReadTokens = sumNullable(runs.map((run) => run.usage?.cacheReadTokens ?? null));
  const estimatedCostUsd = inputTokens === null || outputTokens === null || cacheReadTokens === null
    ? null
    : inputTokens * pricing.inputUsdPerToken
      + outputTokens * pricing.outputUsdPerToken
      + cacheReadTokens * pricing.cacheReadUsdPerToken;

  return {
    id: mode.id,
    thinkingLevel: mode.thinkingLevel,
    maxOutputTokens: mode.maxOutputTokens,
    structuredOutput: mode.structuredOutput,
    productionEligible: mode.productionEligible,
    fixtures: mode.cases.length,
    completeFixtures,
    omittedFiles,
    expectedIssues,
    evidenceLocationCredits,
    findings,
    falsePositives,
    duplicateFindings,
    promptBytes: mode.cases.reduce((total, item) => total + item.promptBytes, 0),
    wallDurationP50Ms: percentile(mode.cases.map((item) => item.wallDurationMs), 0.5),
    wallDurationP95Ms: percentile(mode.cases.map((item) => item.wallDurationMs), 0.95),
    processStartupP50Ms: nullablePercentile(runs.map((run) => run.processStartupMs), 0.5),
    processStartupP95Ms: nullablePercentile(runs.map((run) => run.processStartupMs), 0.95),
    timeToFirstTextP50Ms: nullablePercentile(runs.map((run) => run.timeToFirstTextMs), 0.5),
    timeToFirstTextP95Ms: nullablePercentile(runs.map((run) => run.timeToFirstTextMs), 0.95),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    estimatedCostUsd,
    retries: runs.reduce((total, run) => total + run.retryCount, 0),
  };
}

export function buildModelExecutionReport(
  capture: ModelExecutionCapture,
  fixtures: readonly BenchmarkFixture[],
): ModelExecutionReport {
  const scored = capture.modes.map((mode) => scoreMode(mode, fixtures, capture.pricing));
  const eligible = scored.filter((mode) => mode.productionEligible);
  const maximumCompleteFixtures = Math.max(0, ...eligible.map((mode) => mode.completeFixtures));
  const maximumCredits = Math.max(0, ...eligible
    .filter((mode) => mode.completeFixtures === maximumCompleteFixtures)
    .map((mode) => mode.evidenceLocationCredits));
  const minimumFalsePositives = Math.min(
    ...eligible.filter((mode) => mode.completeFixtures === maximumCompleteFixtures
      && mode.evidenceLocationCredits === maximumCredits)
      .map((mode) => mode.falsePositives),
  );
  const modes: ModelExecutionModeReport[] = scored.map((mode) => ({
    ...mode,
    qualityMaintained: mode.completeFixtures === maximumCompleteFixtures
      && mode.evidenceLocationCredits === maximumCredits
      && mode.falsePositives === minimumFalsePositives,
  }));
  const candidates = modes.filter((mode) => mode.productionEligible && mode.qualityMaintained)
    .sort((left, right) => left.wallDurationP95Ms - right.wallDurationP95Ms
      || (left.estimatedCostUsd ?? Number.POSITIVE_INFINITY)
        - (right.estimatedCostUsd ?? Number.POSITIVE_INFINITY)
      || left.maxOutputTokens - right.maxOutputTokens
      || left.id.localeCompare(right.id));
  const selected = candidates[0] ?? modes.find((mode) => mode.id === 'off-4096') ?? modes[0];
  if (selected === undefined) throw new Error('model execution capture contains no modes');
  const probeSamples = capture.freshProcessProbe.samples;
  const successfulProbeSamples = probeSamples.filter((sample) => sample.status === 'succeeded');
  const probeDurationP95Ms = percentile(probeSamples.map((sample) => sample.durationMs), 0.95);
  return {
    version: MODEL_EXECUTION_REPORT_VERSION,
    kind: 'model-execution-policy',
    sourceCaptureCreatedAt: capture.createdAt,
    harness: capture.harness,
    provider: capture.provider,
    model: capture.model,
    corpusVersion: capture.corpusVersion,
    modes,
    recommendation: {
      mode: selected.id,
      rationale: [
        'Prefer the highest repeated fixture-completion count before considering latency or cost.',
        'Within that completion tier, require the highest evidence-location credit count with the fewest false positives.',
        'Among quality-preserving portable modes, prefer lower p95 wall time, then lower estimated cost and output cap.',
      ],
    },
    freshProcessProbe: {
      samples: probeSamples.length,
      successes: successfulProbeSamples.length,
      durationP50Ms: percentile(probeSamples.map((sample) => sample.durationMs), 0.5),
      durationP95Ms: probeDurationP95Ms,
      timeToFirstTextP50Ms: nullablePercentile(
        probeSamples.map((sample) => sample.timeToFirstTextMs), 0.5,
      ),
      timeToFirstTextP95Ms: nullablePercentile(
        probeSamples.map((sample) => sample.timeToFirstTextMs), 0.95,
      ),
    },
    deadlines: {
      perFileMs: 4 * 60_000,
      wholeRunMs: 10 * 60_000,
      behavior: 'Each invocation receives the lesser of the per-file deadline and remaining whole-run time; unstarted files become explicit run-deadline-exhausted omissions.',
    },
    executionModes: [
      {
        mode: 'fresh-process',
        status: 'selected',
        reason: `Preserves per-file generated configuration, no-session execution, disabled tools, credential isolation, and deterministic cleanup; the local end-to-end fresh-process probe measured ${probeDurationP95Ms} ms p95.`,
      },
      {
        mode: 'rpc-worker',
        status: 'not-selected',
        reason: 'Pi RPC is long-lived, but the current protocol does not prove complete provider, extension, queue, transcript, and credential state reset between untrusted files.',
      },
      {
        mode: 'direct-sdk',
        status: 'not-selected',
        reason: 'The production action intentionally installs no project dependencies; adding the Pi SDK would expand the trusted runtime and credential surface without measured model-bound benefit.',
      },
    ],
  };
}

function metric(value: number | null, digits = 0): string {
  if (value === null) return 'n/a';
  return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
}

export function renderModelExecutionReport(report: ModelExecutionReport): string {
  const lines = [
    '# Model execution policy benchmark',
    '',
    `- Capture: ${report.sourceCaptureCreatedAt}`,
    `- Harness/model: ${report.harness} (${report.provider}/${report.model})`,
    `- Recommendation: \`${report.recommendation.mode}\``,
    '',
    '| Mode | Complete | Credits | Findings | False positives | p50 ms | p95 ms | Spawn-call p95 ms | First text p95 ms | Input tokens | Output tokens | Est. cost USD | Retries | Best quality tier |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const mode of report.modes) {
    lines.push(`| ${mode.id} | ${mode.completeFixtures}/${mode.fixtures} | ${mode.evidenceLocationCredits}/${mode.expectedIssues} | ${mode.findings} | ${mode.falsePositives} | ${mode.wallDurationP50Ms} | ${mode.wallDurationP95Ms} | ${metric(mode.processStartupP95Ms)} | ${metric(mode.timeToFirstTextP95Ms)} | ${metric(mode.inputTokens)} | ${metric(mode.outputTokens)} | ${metric(mode.estimatedCostUsd, 6)} | ${mode.retries} | ${mode.qualityMaintained ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Recommendation', '', ...report.recommendation.rationale.map((item) => `- ${item}`));
  lines.push(
    '',
    '## Fresh-process overhead',
    '',
    `- Successful samples: ${report.freshProcessProbe.successes}/${report.freshProcessProbe.samples}.`,
    `- End-to-end local p50/p95: ${report.freshProcessProbe.durationP50Ms}/${report.freshProcessProbe.durationP95Ms} ms.`,
    `- Local time-to-first-text p50/p95: ${metric(report.freshProcessProbe.timeToFirstTextP50Ms)}/${metric(report.freshProcessProbe.timeToFirstTextP95Ms)} ms.`,
  );
  lines.push('', '## Deadlines', '', `- Per file: ${report.deadlines.perFileMs} ms.`, `- Whole run: ${report.deadlines.wholeRunMs} ms.`, `- ${report.deadlines.behavior}`);
  lines.push('', '## Process and provider execution modes', '');
  for (const mode of report.executionModes) lines.push(`- **${mode.mode} — ${mode.status}:** ${mode.reason}`);
  lines.push(
    '',
    '## Interpretation',
    '',
    '- The quality comparison uses Redline-validated findings and credits only findings whose complete validated span falls inside a checked-in expected-issue location.',
    '- `Best quality tier` is relative within this capture. No mode completed all fixtures or credited all expected issues, so this is not an absolute quality pass.',
    '- The JSON response-format mode is a capability probe, not a portable production candidate. OpenAI-compatible endpoints differ in response-format support.',
    '- Token cost is estimated from the capture pricing and Pi usage metadata. Prompts, source, raw output, reasoning, credentials, and publication tokens are not stored in this artifact.',
    '- The report is bounded benchmark evidence. It does not replace the five-run live SLO gate.',
    '',
  );
  return lines.join('\n');
}

export async function loadModelExecutionCapture(path: string): Promise<ModelExecutionCapture> {
  const value = JSON.parse(await readFile(resolve(path), 'utf8')) as ModelExecutionCapture;
  if (value.version !== MODEL_EXECUTION_CAPTURE_VERSION || value.kind !== 'live-model-execution') {
    throw new Error('model execution capture is unsupported');
  }
  return value;
}

export async function writeModelExecutionArtifacts(
  jsonPath: string,
  markdownPath: string,
  report: ModelExecutionReport,
): Promise<void> {
  await Promise.all([mkdir(dirname(jsonPath), { recursive: true }), mkdir(dirname(markdownPath), { recursive: true })]);
  const jsonTemporary = `${jsonPath}.tmp-${process.pid}-${randomUUID()}`;
  const markdownTemporary = `${markdownPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await Promise.all([
      writeFile(jsonTemporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 }),
      writeFile(markdownTemporary, renderModelExecutionReport(report), { flag: 'wx', mode: 0o600 }),
    ]);
    await Promise.all([rename(jsonTemporary, jsonPath), rename(markdownTemporary, markdownPath)]);
  } catch (error) {
    await Promise.all([rm(jsonTemporary, { force: true }), rm(markdownTemporary, { force: true })]);
    throw error;
  }
}
