import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBenchmarkCorpus } from '../src/benchmark/benchmark.ts';
import { runVerificationBenchmark, type RecordedDecision } from '../src/benchmark/verification-benchmark.ts';

const ORIGINAL = resolve('benchmark/review-quality/v2');
const EXTENSION = resolve('benchmark/review-quality/verification-v1');
const DECISIONS = resolve(EXTENSION, 'dispositions.json');

async function recordedDecisions(): Promise<readonly RecordedDecision[]> {
  const parsed = JSON.parse(await readFile(DECISIONS, 'utf8')) as { decisions: RecordedDecision[] };
  return parsed.decisions;
}

describe('scripted candidate verification quality gate', () => {
  it('uses the existing corpus plus independently checked clean and cross-file fixtures', async () => {
    const extension = await loadBenchmarkCorpus(EXTENSION);
    expect(extension.fixtures.map((fixture) => [fixture.id, fixture.kind]))
      .toEqual([['clean-default-parameter', 'clean'], ['cross-file-rate-limit', 'defect']]);
    const report = await runVerificationBenchmark(ORIGINAL, EXTENSION, DECISIONS);
    expect(report.cases).toHaveLength(12);
    expect(report.cases.filter((item) => item.kind === 'defect')).toHaveLength(6);
    expect(report.cases.reduce((total, item) => total + item.requested, 0)).toBe(6);
    expect(report.cases.reduce((total, item) => total + item.confirmed, 0)).toBe(4);
    expect(report.cases.reduce((total, item) => total + item.disproved, 0)).toBe(2);
    expect(report.cases.reduce((total, item) => total + item.verificationDurationMs, 0)).toBe(112);
    const indexedCrossFile = report.cases.find((item) => item.fixtureId === 'cross-file-rate-limit'
      && item.mode === 'indexed-context');
    expect(indexedCrossFile).toMatchObject({
      discovery: { creditedIssues: 1 }, verified: { creditedIssues: 1 },
      published: { creditedIssues: 1, duplicateFindings: 0 },
      publication: { commentsBeforeSynthesis: 1, commentsAfterSynthesis: 1,
        duplicateCommentsSuppressed: 0, budgetSuppressed: 0, criticalSuppressed: 0 },
      requested: 1, confirmed: 1, requiredCoverageComplete: true,
    });
    const clean = report.cases.find((item) => item.fixtureId === 'clean-default-parameter'
      && item.mode === 'file-only');
    expect(clean).toMatchObject({
      discovery: { falsePositives: 1 }, verified: { falsePositives: 0 },
      published: { falsePositives: 0 }, publication: { commentsAfterSynthesis: 0 },
      requested: 1, disproved: 1, requiredCoverageComplete: true,
    });
    expect(report.gate).toMatchObject({
      passedOnScriptedRecordings: true,
      recallRegressions: [],
      cleanFalsePositiveRegressions: [],
      incompleteCoverage: [],
      activationReady: false,
    });
    expect(report.gate.activationReason).toContain('do not measure independent model recall');
    expect(JSON.parse(await readFile(resolve('benchmark/policy-v8/verification/report.json'), 'utf8'))).toEqual(report);
  });

  it('fails when the scripted verifier rejects a known defect instead of hiding a recall regression', async () => {
    const decisions = (await recordedDecisions()).map((item) => item.fixtureId === 'cross-file-cache-collision'
      ? { ...item, disposition: 'rejected' as const } : item);
    const report = await runVerificationBenchmark(ORIGINAL, EXTENSION, DECISIONS, decisions);
    expect(report.gate.passedOnScriptedRecordings).toBe(false);
    expect(report.gate.recallRegressions).toEqual(['cross-file-cache-collision/indexed-context']);
    expect(report.gate.activationReady).toBe(false);
  });

  it('does not mistake unchanged clean-change false positives for proof of model quality', async () => {
    const decisions = (await recordedDecisions()).map((item) => item.fixtureId === 'clean-default-parameter'
      ? { ...item, disposition: 'confirmed' as const } : item);
    const report = await runVerificationBenchmark(ORIGINAL, EXTENSION, DECISIONS, decisions);
    expect(report.gate.passedOnScriptedRecordings).toBe(true);
    expect(report.gate.cleanFalsePositiveRegressions).toEqual([]);
    const clean = report.cases.find((item) => item.fixtureId === 'clean-default-parameter'
      && item.mode === 'file-only');
    expect(clean?.verified.falsePositives).toBe(1);
    // A verifier that merely preserves a pre-existing false positive does not exceed the
    // baseline, but independent model quality remains unproved and activation stays disabled.
    expect(report.gate.activationReady).toBe(false);
  });

  it('requires exactly one decision for each candidate rather than silently skipping verification', async () => {
    const decisions = (await recordedDecisions()).slice(1);
    await expect(runVerificationBenchmark(ORIGINAL, EXTENSION, DECISIONS, decisions))
      .rejects.toThrow('do not exactly cover discovery candidates');
  });
});
