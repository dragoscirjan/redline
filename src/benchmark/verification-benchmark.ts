import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HarnessExecutor, HarnessPrompt, HarnessRun, HarnessSettings, PreparedHarness } from '../harness-executor/types.js';
import { parseDuration } from '../duration.js';
import type { ReviewEnvironment } from '../review/environment.js';
import { runFileReviews } from '../review/runner.js';
import type { FileReviewRecord } from '../review/types.js';
import { VERIFICATION_PROMPT_ID } from '../review/verification-prompt.js';
import {
  loadBenchmarkCorpus, materializeBenchmarkFixture, scoreBenchmarkCase,
  type BenchmarkCaseResult, type BenchmarkFixture, type BenchmarkMode, type FixtureRecording,
} from './benchmark.js';

export interface RecordedDecision {
  readonly fixtureId: string;
  readonly mode: BenchmarkMode;
  readonly fileId: string;
  readonly findingIndex: number;
  readonly disposition: 'confirmed' | 'rejected';
  readonly durationMs: number;
}

export interface VerificationBenchmarkCase {
  readonly fixtureId: string;
  readonly mode: BenchmarkMode;
  readonly kind: 'clean' | 'defect';
  readonly discovery: BenchmarkCaseResult;
  readonly verified: BenchmarkCaseResult;
  readonly published: BenchmarkCaseResult;
  readonly publication: {
    readonly commentsBeforeSynthesis: number;
    readonly commentsAfterSynthesis: number;
    readonly duplicateCommentsSuppressed: number;
    readonly budgetSuppressed: number;
    readonly criticalSuppressed: number;
  };
  readonly requested: number;
  readonly confirmed: number;
  readonly disproved: number;
  readonly verificationDurationMs: number;
  readonly requiredCoverageComplete: boolean;
}

export interface VerificationBenchmarkReport {
  readonly version: 1;
  readonly evidence: 'scripted-verifier-decisions';
  readonly cases: readonly VerificationBenchmarkCase[];
  readonly gate: {
    readonly passedOnScriptedRecordings: boolean;
    readonly recallRegressions: readonly string[];
    readonly cleanFalsePositiveRegressions: readonly string[];
    readonly incompleteCoverage: readonly string[];
    readonly activationReady: false;
    readonly activationReason: string;
  };
}

function decisionKey(fileId: string, index: number): string {
  return `${fileId}:${index}`;
}

function parseDecisions(value: unknown): readonly RecordedDecision[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('verifier decisions must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'decisions,kind,version'
    || input['version'] !== 1 || input['kind'] !== 'scripted-verifier-decisions'
    || !Array.isArray(input['decisions']) || input['decisions'].length > 100) {
    throw new Error('verifier decisions schema is invalid');
  }
  const seen = new Set<string>();
  return input['decisions'].map((value: unknown): RecordedDecision => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('verifier decision must be an object');
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'disposition,durationMs,fileId,findingIndex,fixtureId,mode'
      || typeof entry['fixtureId'] !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry['fixtureId'])
      || typeof entry['fileId'] !== 'string' || !/^\d{6}$/u.test(entry['fileId'])
      || (entry['mode'] !== 'file-only' && entry['mode'] !== 'indexed-context')
      || (entry['disposition'] !== 'confirmed' && entry['disposition'] !== 'rejected')
      || !Number.isSafeInteger(entry['findingIndex']) || (entry['findingIndex'] as number) < 0
      || !Number.isSafeInteger(entry['durationMs']) || (entry['durationMs'] as number) < 0) {
      throw new Error('verifier decision is invalid');
    }
    const parsed = entry as unknown as RecordedDecision;
    const key = `${parsed.fixtureId}:${parsed.mode}:${decisionKey(parsed.fileId, parsed.findingIndex)}`;
    if (seen.has(key)) throw new Error(`duplicate verifier decision: ${key}`);
    seen.add(key);
    return parsed;
  });
}

class ScriptedExecutor implements HarnessExecutor {
  readonly harness = 'echo' as const;
  readonly #recording: FixtureRecording;
  readonly #original: ReadonlyMap<string, FileReviewRecord>;
  readonly #decisions: ReadonlyMap<string, RecordedDecision>;
  readonly #fixture: BenchmarkFixture;
  #index = 0;
  #currentFile: string | undefined;
  promptBytes = 0;

  constructor(
    fixture: BenchmarkFixture,
    recording: FixtureRecording,
    original: readonly FileReviewRecord[] = [],
    decisions: readonly RecordedDecision[] = [],
  ) {
    this.#fixture = fixture;
    this.#recording = recording;
    this.#original = new Map(original.map((item) => [item.fileId, item]));
    this.#decisions = new Map(decisions.map((item) => [decisionKey(item.fileId, item.findingIndex), item]));
  }

  async prepare(settings: HarnessSettings): Promise<PreparedHarness> {
    return { harness: 'echo', model: settings.model, description: 'scripted verification benchmark' };
  }

  async execute(_prepared: PreparedHarness, prompt: HarnessPrompt): Promise<HarnessRun> {
    this.promptBytes += Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
    if (prompt.system.includes(VERIFICATION_PROMPT_ID)) {
      const fileId = this.#currentFile;
      const original = fileId === undefined ? undefined : this.#original.get(fileId);
      const file = this.#fixture.files.find((item) => item.id === fileId);
      if (fileId === undefined || original === undefined || file === undefined || original.findings.length === 0) {
        throw new Error('verifier ran without prior validated discovery candidates');
      }
      const candidates = original.findings.map((finding, index) => {
        const decision = this.#decisions.get(decisionKey(fileId, index));
        if (decision === undefined) throw new Error(`missing verifier decision for ${fileId}:${index}`);
        return { finding, decision };
      });
      const durationMs = Math.max(...candidates.map((item) => item.decision.durationMs));
      return {
        harness: 'echo', status: 'succeeded', exitCode: 0, diagnostic: '', durationMs,
        text: JSON.stringify({
          version: 1,
          fileId,
          results: candidates.map(({ finding, decision }) => ({
            candidateId: finding.id,
            disposition: decision.disposition,
            reason: decision.disposition === 'confirmed'
              ? 'Recorded source-backed confirmation for deterministic replay.'
              : 'Recorded falsification for deterministic replay.',
            citations: decision.disposition === 'confirmed' ? [{
              role: 'contract',
              revision: finding.side === 'LEFT' ? this.#fixture.baseRevision : this.#fixture.headRevision,
              path: file.path,
              startLine: finding.startLine,
              endLine: finding.endLine,
              evidence: finding.evidence,
            }] : [],
          })),
        }),
      };
    }
    const response = this.#recording.responses[this.#index++];
    if (response === undefined) throw new Error('discovery ran out of recorded model responses');
    this.#currentFile = response.fileId;
    return {
      harness: 'echo', status: 'succeeded', exitCode: 0, diagnostic: '',
      durationMs: response.durationMs, text: JSON.stringify(response.document),
    };
  }
}

async function runCase(
  fixture: BenchmarkFixture,
  recording: FixtureRecording,
  decisions: readonly RecordedDecision[],
): Promise<VerificationBenchmarkCase> {
  const root = await mkdtemp(join(tmpdir(), 'redline-verify-benchmark-'));
  try {
    const paths = await materializeBenchmarkFixture(fixture, root);
    let codeContext: ReviewEnvironment['codeContext'];
    if (recording.mode === 'indexed-context') {
      const path = join(root, 'code-context.json');
      await writeFile(path, `${JSON.stringify(recording.codeContext)}\n`);
      codeContext = { path, repository: recording.codeContext.repository };
    }
    const environment: ReviewEnvironment = {
      harness: 'echo',
      reviewDirectory: paths.review,
      sourceDirectory: paths.source,
      outputDirectory: paths.output,
      codeContext,
      model: { provider: 'benchmark', endpoint: 'http://127.0.0.1', model: 'recorded', auth: 'none' },
      credential: undefined,
      findingScope: 'defects',
      timeout: parseDuration('1m'),
      reviewConcurrency: 1,
    };
    const discoveryExecutor = new ScriptedExecutor(fixture, recording);
    const discovery = await runFileReviews({ environment, executor: discoveryExecutor });
    const originalById = new Map(discovery.records.map((record) => [record.fileId, record]));
    const keys = new Set(discovery.records.flatMap((record) => record.findings.map((_item, index) =>
      decisionKey(record.fileId, index))));
    if (decisions.length !== keys.size || decisions.some((item) => !keys.has(decisionKey(item.fileId, item.findingIndex)))) {
      throw new Error(`verifier decisions do not exactly cover discovery candidates for ${fixture.id}/${recording.mode}`);
    }
    const verifierExecutor = new ScriptedExecutor(fixture, recording, discovery.records, decisions);
    const verified = await runFileReviews({
      environment: { ...environment, outputDirectory: join(root, 'verified-output') },
      executor: verifierExecutor,
      verifyCandidates: true,
    });
    const remapped = verified.records.flatMap((record) => record.findings.map((finding, index) => {
      const originalIndex = originalById.get(record.fileId)?.findings.findIndex((item) => item.id === finding.id) ?? -1;
      const original = recording.judgments.find((item) => item.fileId === record.fileId && item.findingIndex === originalIndex);
      if (original === undefined) throw new Error(`verified finding lacks original judgment: ${fixture.id}/${recording.mode}`);
      return { ...original, findingIndex: index };
    }));
    const baselineScore = scoreBenchmarkCase(fixture, recording, discovery.records, discoveryExecutor.promptBytes, {
      ...discovery.summary.codeContext,
      timings: recording.mode === 'indexed-context' ? recording.codeContext.timings : null,
    });
    const verifiedScore = scoreBenchmarkCase(fixture, { ...recording, judgments: remapped }, verified.records,
      verifierExecutor.promptBytes, {
        ...verified.summary.codeContext,
        timings: recording.mode === 'indexed-context' ? recording.codeContext.timings : null,
      });
    const plan = verified.review.synthesis;
    if (plan === undefined) throw new Error('verified benchmark lacks the required synthesis plan');
    const selected = new Set(plan.decisions.filter((item) => item.status === 'publish').map((item) =>
      `${item.fileId}:${item.findingId}`));
    const publicationRecords = verified.records.map((record) => ({
      ...record, findings: record.findings.filter((finding) => selected.has(`${record.fileId}:${finding.id}`)),
    }));
    const publicationJudgments = publicationRecords.flatMap((record) => record.findings.map((finding, index) => {
      const before = verified.records.find((item) => item.fileId === record.fileId)?.findings
        .findIndex((item) => item.id === finding.id) ?? -1;
      const judgment = remapped.find((item) => item.fileId === record.fileId && item.findingIndex === before);
      if (judgment === undefined) throw new Error(`publication representative lacks a judgment: ${fixture.id}`);
      return { ...judgment, findingIndex: index };
    }));
    const publishedScore = scoreBenchmarkCase(fixture,
      { ...recording, judgments: publicationJudgments }, publicationRecords,
      verifierExecutor.promptBytes, {
        ...verified.summary.codeContext,
        timings: recording.mode === 'indexed-context' ? recording.codeContext.timings : null,
      });
    const budgetSuppressed = plan.decisions.filter((item) =>
      item.status === 'file-budget' || item.status === 'comment-budget').length;
    const coverage = verified.records.map((record) => record.verification);
    return {
      fixtureId: fixture.id,
      mode: recording.mode,
      kind: fixture.kind,
      discovery: baselineScore,
      verified: verifiedScore,
      published: publishedScore,
      publication: {
        commentsBeforeSynthesis: verified.records.reduce((sum, record) => sum + record.findings.length, 0),
        commentsAfterSynthesis: selected.size,
        duplicateCommentsSuppressed: plan.decisions.filter((item) => item.status === 'duplicate').length,
        budgetSuppressed,
        criticalSuppressed: plan.decisions.filter((item) =>
          (item.status === 'file-budget' || item.status === 'comment-budget')
          && verified.review.findings.some((finding) => finding.id === item.findingId
            && finding.triggerFileId === item.fileId && finding.severity === 'critical')).length,
      },
      requested: coverage.reduce((total, item) => total + (item?.requested ?? 0), 0),
      confirmed: coverage.reduce((total, item) => total + (item?.accepted ?? 0), 0),
      disproved: coverage.reduce((total, item) => total + (item?.rejected ?? 0), 0),
      verificationDurationMs: coverage.reduce((total, item) => total + (item?.durationMs ?? 0), 0),
      requiredCoverageComplete: verified.records.every((record) =>
        record.outcome !== 'omitted' && record.verification?.status !== 'incomplete'
        && record.followUp?.status !== 'incomplete')
        && verified.review.coverage.publication?.status !== 'incomplete',
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** This scripted corpus checks pipeline behavior, not independent model quality. */
export async function runVerificationBenchmark(
  baselineDirectory: string,
  extensionDirectory: string,
  decisionsPath: string,
  decisionsOverride?: readonly RecordedDecision[],
): Promise<VerificationBenchmarkReport> {
  const baseline = await loadBenchmarkCorpus(baselineDirectory);
  const extension = await loadBenchmarkCorpus(extensionDirectory);
  const fixtureIds = new Set([...baseline.fixtures, ...extension.fixtures].map((fixture) => fixture.id));
  if (fixtureIds.size !== baseline.fixtures.length + extension.fixtures.length) {
    throw new Error('verification benchmark fixture IDs must be unique');
  }
  const decisions = decisionsOverride ?? parseDecisions(JSON.parse(await readFile(resolve(decisionsPath), 'utf8')) as unknown);
  const cases: VerificationBenchmarkCase[] = [];
  for (const fixture of [...baseline.fixtures, ...extension.fixtures]) {
    for (const recording of fixture.recordings) {
      cases.push(await runCase(fixture, recording, decisions.filter((decision) =>
        decision.fixtureId === fixture.id && decision.mode === recording.mode)));
    }
  }
  const unknown = decisions.filter((decision) => !fixtureIds.has(decision.fixtureId));
  if (unknown.length > 0) throw new Error('verifier decisions reference unknown fixtures');
  const label = (item: VerificationBenchmarkCase): string => `${item.fixtureId}/${item.mode}`;
  const recallRegressions = cases.filter((item) =>
    item.verified.creditedIssues < item.discovery.creditedIssues
    || item.published.creditedIssues < item.discovery.creditedIssues).map(label);
  const cleanFalsePositiveRegressions = cases.filter((item) => item.kind === 'clean'
    && (item.verified.falsePositives > item.discovery.falsePositives
      || item.published.falsePositives > item.discovery.falsePositives)).map(label);
  const incompleteCoverage = cases.filter((item) => !item.requiredCoverageComplete).map(label);
  return {
    version: 1,
    evidence: 'scripted-verifier-decisions',
    cases,
    gate: {
      passedOnScriptedRecordings: recallRegressions.length === 0
        && cleanFalsePositiveRegressions.length === 0 && incompleteCoverage.length === 0,
      recallRegressions,
      cleanFalsePositiveRegressions,
      incompleteCoverage,
      activationReady: false,
      activationReason: 'Scripted dispositions exercise the pipeline but do not measure independent model recall or production latency.',
    },
  };
}
