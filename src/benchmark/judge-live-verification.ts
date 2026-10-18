#!/usr/bin/env node
/** Scores explicitly human-judged live captures against predeclared issues.
 * This never infers a match from model prose or promotes a scripted verdict. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBenchmarkCorpus, type BenchmarkFixture } from './benchmark.js';
import type { FileReviewRecord, ReviewSynthesis } from '../review/types.js';

export interface LiveJudgment {
  readonly fixtureId: string;
  readonly mode: string;
  readonly fileId: string;
  readonly findingId: string;
  readonly expectedIssueId: string | null;
  readonly validEvidence: boolean;
}

interface LiveCase {
  readonly fixtureId: string;
  readonly mode: 'file-only' | 'indexed-context';
  readonly discovery: { readonly durationMs: number; readonly records: readonly FileReviewRecord[] };
  readonly verified: { readonly durationMs: number; readonly records: readonly FileReviewRecord[];
    readonly synthesis?: ReviewSynthesis | undefined };
}

interface Capture {
  readonly version: 1;
  readonly kind: 'live-verification-replay';
  readonly createdAt: string;
  readonly harness: string;
  readonly provider: string;
  readonly model: string;
  readonly cases: readonly LiveCase[];
}

function candidates(records: readonly FileReviewRecord[]): readonly { fileId: string; finding: FileReviewRecord['findings'][number];
  path: string }[] {
  return records.flatMap((record) => record.findings.map((finding) => ({ fileId: record.fileId,
    finding, path: record.path })));
}

function id(fixtureId: string, mode: string, fileId: string, findingId: string): string {
  return [fixtureId, mode, fileId, findingId].join(':');
}

function credited(
  fixture: BenchmarkFixture,
  mode: string,
  found: ReturnType<typeof candidates>,
  judgments: ReadonlyMap<string, LiveJudgment>,
): Set<string> {
  const matched = new Set<string>();
  for (const item of found) {
    const judgment = judgments.get(id(fixture.id, mode, item.fileId, item.finding.id));
    if (judgment === undefined) throw new Error(`live finding lacks independent judgment: ${fixture.id}/${mode}/${item.finding.id}`);
    if (judgment.expectedIssueId === null || !judgment.validEvidence) continue;
    const issue = fixture.expectedIssues.find((entry) => entry.id === judgment.expectedIssueId);
    if (issue === undefined || !issue.locations.some((location) =>
      location.path === item.path && location.side === item.finding.side
      && item.finding.startLine >= location.startLine && item.finding.endLine <= location.endLine)) {
      throw new Error(`human judgment does not map to a predeclared authoritative diff location: ${fixture.id}`);
    }
    matched.add(issue.id);
  }
  return matched;
}

export async function judgeLiveVerification(
  captureDirectory = resolve('benchmark/review-quality/verification-v1/live-model'),
): Promise<Record<string, unknown>> {
  const path = (name: string): string => resolve(captureDirectory, name);
  const captures = await Promise.all(['baseline-capture.json', 'extension-capture.json'].map(async (name) =>
    JSON.parse(await readFile(path(name), 'utf8')) as Capture));
  const judgmentDocument = JSON.parse(await readFile(path('judgments.json'), 'utf8')) as {
    version: number; judgments: LiveJudgment[];
  };
  if (judgmentDocument.version !== 1 || !Array.isArray(judgmentDocument.judgments)) {
    throw new Error('live judgment file is not version 1');
  }
  const fixtures = (await Promise.all(['v2', 'verification-v1'].map(async (directory) =>
    (await loadBenchmarkCorpus(resolve('benchmark/review-quality', directory))).fixtures))).flat();
  const unique = new Set<string>();
  const judgments = new Map(judgmentDocument.judgments.map((item) => {
    const key = id(item.fixtureId, item.mode, item.fileId, item.findingId);
    if (unique.has(key) || typeof item.validEvidence !== 'boolean') throw new Error('duplicate or malformed live judgment');
    unique.add(key);
    return [key, item] as const;
  }));
  const used = new Set<string>();
  const cases = captures.flatMap((capture) => {
    if (capture.version !== 1 || capture.kind !== 'live-verification-replay') throw new Error('unsupported live capture');
    return capture.cases;
  });
  if (cases.length !== 12) throw new Error('live capture must cover all six fixtures in both modes');
  const caseKeys = new Set<string>();
  const perCase = cases.map((captureCase) => {
    const caseKey = `${captureCase.fixtureId}/${captureCase.mode}`;
    if (caseKeys.has(caseKey)) throw new Error('duplicate live case');
    caseKeys.add(caseKey);
    const fixture = fixtures.find((item) => item.id === captureCase.fixtureId);
    if (fixture === undefined) throw new Error(`unknown live fixture: ${captureCase.fixtureId}`);
    const discovery = candidates(captureCase.discovery.records);
    const verified = candidates(captureCase.verified.records);
    for (const item of discovery) used.add(id(fixture.id, captureCase.mode, item.fileId, item.finding.id));
    const discoveredIssues = credited(fixture, captureCase.mode, discovery, judgments);
    const verifiedIssues = credited(fixture, captureCase.mode, verified, judgments);
    const planned = captureCase.verified.synthesis?.decisions.filter((entry) => entry.status === 'publish') ?? [];
    const published = verified.filter((item) => planned.some((entry) =>
      entry.fileId === item.fileId && entry.findingId === item.finding.id));
    const publishedIssues = credited(fixture, captureCase.mode, published, judgments);
    const incomplete = captureCase.verified.records.some((record) => record.outcome === 'omitted'
      || record.verification?.status === 'incomplete' || record.followUp?.status === 'incomplete');
    const calls = captureCase.verified.records.filter((record) => (record.verification?.requested ?? 0) > 0)
      .map((record) => record.verification?.durationMs ?? 0);
    return {
      fixtureId: fixture.id, kind: fixture.kind, mode: captureCase.mode,
      expectedIssues: fixture.expectedIssues.length,
      discoveryCredited: discoveredIssues.size, verifiedCredited: verifiedIssues.size,
      publishedCredited: publishedIssues.size,
      discoveryFindings: discovery.length, verifiedFindings: verified.length,
      publishedComments: published.length,
      cleanFalsePositivesBefore: fixture.kind === 'clean' ? discovery.length : 0,
      cleanFalsePositivesAfter: fixture.kind === 'clean' ? published.length : 0,
      duplicateCommentsSuppressed: captureCase.verified.synthesis?.decisions.filter((entry) =>
        entry.status === 'duplicate').length ?? 0,
      discoveryOmitted: captureCase.discovery.records.filter((record) => record.outcome === 'omitted').length,
      requiredCoverageIncomplete: incomplete,
      discoveryDurationMs: captureCase.discovery.durationMs,
      verifierDurationMs: calls.reduce((sum, duration) => sum + duration, 0),
      verifierCalls: calls.length,
    };
  });
  if (unique.size !== used.size || [...unique].some((key) => !used.has(key))) {
    throw new Error('judgments must cover every accepted discovery finding exactly once');
  }
  const modes = (['file-only', 'indexed-context'] as const).map((mode) => {
    const subset = perCase.filter((item) => item.mode === mode);
    const sum = (key: 'discoveryCredited' | 'verifiedCredited' | 'publishedCredited'
      | 'cleanFalsePositivesBefore' | 'cleanFalsePositivesAfter' | 'discoveryDurationMs'
      | 'verifierDurationMs' | 'verifierCalls' | 'publishedComments' | 'duplicateCommentsSuppressed'): number =>
      subset.reduce((total, item) => total + item[key], 0);
    return { mode, expectedIssues: subset.reduce((total, item) => total + item.expectedIssues, 0),
      discoveryCredited: sum('discoveryCredited'), verifiedCredited: sum('verifiedCredited'),
      publishedCredited: sum('publishedCredited'), cleanFalsePositivesBefore: sum('cleanFalsePositivesBefore'),
      cleanFalsePositivesAfter: sum('cleanFalsePositivesAfter'),
      publishedComments: sum('publishedComments'), duplicateCommentsSuppressed: sum('duplicateCommentsSuppressed'),
      discoveryDurationMs: sum('discoveryDurationMs'), verifierDurationMs: sum('verifierDurationMs'),
      verifierCalls: sum('verifierCalls'),
      requiredCoverageIncomplete: subset.filter((item) => item.requiredCoverageIncomplete).length };
  });
  const latencies = perCase.flatMap((item) => item.verifierCalls === 0 ? [] : [item.verifierDurationMs]).sort((a, b) => a - b);
  const p95 = latencies.length > 0 ? latencies[Math.ceil(latencies.length * 0.95) - 1]! : null;
  const recallRegressions = perCase.filter((item) => item.verifiedCredited < item.discoveryCredited
    || item.publishedCredited < item.discoveryCredited).map((item) => `${item.fixtureId}/${item.mode}`);
  const cleanFalsePositiveRegressions = perCase.filter((item) => item.cleanFalsePositivesAfter
    > item.cleanFalsePositivesBefore).map((item) => `${item.fixtureId}/${item.mode}`);
  const incompleteCoverage = perCase.filter((item) => item.requiredCoverageIncomplete)
    .map((item) => `${item.fixtureId}/${item.mode}`);
  return { version: 1, evidence: 'independently-judged-live-model-replay',
    captureDates: captures.map((item) => item.createdAt), harness: captures[0]?.harness,
    provider: captures[0]?.provider, model: captures[0]?.model, judgmentCount: judgments.size,
    cases: perCase, modes,
    gate: { activationReady: recallRegressions.length === 0 && cleanFalsePositiveRegressions.length === 0
      && incompleteCoverage.length === 0 && p95 !== null && p95 <= 120_000,
    recallRegressions, cleanFalsePositiveRegressions, incompleteCoverage,
    verifierP95Ms: p95, latencyThresholdMs: 120_000,
    limitation: 'Single sequential provider capture; latency is not a stable distribution. Follow-up provider execution was unavailable.' },
  };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const output = resolve('benchmark/review-quality/verification-v1/live-model/report.json');
  try {
    await writeFile(output, `${JSON.stringify(await judgeLiveVerification(), null, 2)}\n`);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`redline-live-verification-judge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
