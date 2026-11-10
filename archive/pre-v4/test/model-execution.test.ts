import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { BenchmarkFixture } from '../src/benchmark/benchmark.ts';
import {
  buildModelExecutionReport,
  renderModelExecutionReport,
  type ModelExecutionCapture,
  type ModelExecutionModeCapture,
} from '../src/benchmark/model-execution.ts';
import type { FileReviewRecord, PublishedFinding } from '../src/review/types.ts';

const CODE_CONTEXT = {
  status: 'disabled' as const,
  provider: null,
  revision: null,
  relatedSpans: 0,
  sourceBytes: 0,
  reason: 'not-configured' as const,
};

const FINDING = {
  id: 'finding-1',
  side: 'RIGHT',
  startLine: 2,
  endLine: 2,
} as unknown as PublishedFinding;

function record(outcome: 'findings' | 'clean' | 'omitted'): FileReviewRecord {
  return {
    version: 4,
    fileId: '000001',
    path: 'src/example.ts',
    status: 'M',
    harness: 'pi',
    model: 'test-model',
    codeContext: CODE_CONTEXT,
    outcome,
    ...(outcome === 'omitted' ? { errorKind: 'harness-failed' as const, reason: 'failed' } : {}),
    findings: outcome === 'findings' ? [FINDING] : [],
    rejectedCandidates: [],
    durationMs: 100,
    execution: 'executed',
  };
}

function mode(
  id: string,
  wallDurationMs: number,
  outcome: 'findings' | 'clean' | 'omitted',
  productionEligible = true,
): ModelExecutionModeCapture {
  return {
    id,
    thinkingLevel: id.startsWith('minimal') ? 'minimal' : id.startsWith('low') ? 'low' : 'off',
    maxOutputTokens: id.includes('16384') ? 16_384 : 4_096,
    structuredOutput: id.endsWith('json') ? 'json-object' : 'none',
    productionEligible,
    cases: [{
      fixtureId: 'defect',
      iteration: 1,
      wallDurationMs,
      promptBytes: 1_000,
      runs: [{
        status: outcome === 'omitted' ? 'failed' : 'succeeded',
        durationMs: wallDurationMs,
        processStartupMs: 15,
        timeToFirstTextMs: 50,
        retryCount: 0,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 120,
          costUsd: null,
        },
      }],
      records: [record(outcome)],
    }],
  };
}

const FIXTURE: BenchmarkFixture = {
  version: 2,
  id: 'defect',
  title: 'Defect fixture',
  kind: 'defect',
  baseRevision: 'a'.repeat(40),
  headRevision: 'b'.repeat(40),
  files: [{
    id: '000001', path: 'src/example.ts', status: 'M',
    base: 'old\n', head: 'new\n', diff: '@@ -1 +1 @@\n-old\n+new\n',
  }],
  additionalHeadFiles: {},
  expectedIssues: [{
    id: 'issue-1',
    title: 'Expected defect',
    locations: [{ path: 'src/example.ts', side: 'RIGHT', startLine: 2, endLine: 2 }],
  }],
  recordings: [],
};

describe('model execution benchmark', () => {
  it('keeps the checked-in live capture metadata-only and credential-free', async () => {
    const text = await readFile(
      'benchmark/model-execution/v1/live-glm-5.3-flash/capture.json',
      'utf8',
    );
    const capture = JSON.parse(text) as unknown;
    const keys: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        visit(child);
      }
    };
    visit(capture);
    expect(keys).not.toEqual(expect.arrayContaining([
      'rawModelOutput', 'fixPrompt', 'evidence', 'rootCause', 'reasoning', 'credential',
    ]));
    expect(text).not.toContain('sk-or-');
  });

  it('selects the fastest complete quality-preserving portable mode and estimates cost', () => {
    const capture: ModelExecutionCapture = {
      version: 1,
      kind: 'live-model-execution',
      corpusVersion: 2,
      createdAt: '2026-03-24T00:00:00.000Z',
      harness: 'pi',
      provider: 'mock',
      model: 'test-model',
      pricing: {
        inputUsdPerToken: 0.00000015,
        outputUsdPerToken: 0.0000005,
        cacheReadUsdPerToken: 0.00000003,
      },
      freshProcessProbe: {
        samples: [{
          status: 'succeeded', durationMs: 80, processStartupMs: 1,
          timeToFirstTextMs: 70, retryCount: 0, usage: null,
        }],
      },
      modes: [
        mode('off-4096', 100, 'findings'),
        mode('minimal-4096', 200, 'findings'),
        mode('low-4096', 50, 'omitted'),
        mode('off-4096-json', 25, 'findings', false),
      ],
    };

    const report = buildModelExecutionReport(capture, [FIXTURE]);
    expect(report.recommendation.mode).toBe('off-4096');
    const selectedMode = report.modes.find((item) => item.id === 'off-4096');
    expect(selectedMode).toMatchObject({
      completeFixtures: 1,
      evidenceLocationCredits: 1,
      falsePositives: 0,
      qualityMaintained: true,
    });
    expect(selectedMode?.estimatedCostUsd).toBeCloseTo(0.000025, 10);
    expect(report.modes.find((item) => item.id === 'low-4096')?.qualityMaintained).toBe(false);
    expect(report.freshProcessProbe.durationP95Ms).toBe(80);
    expect(renderModelExecutionReport(report)).toContain('RPC is long-lived');
  });
});
