import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessExecutor } from '../src/harness-executor/types.js';
import { loadPerformanceCorpus } from '../src/benchmark/performance-corpus.js';
import {
  loadPerformanceProfile,
  renderPerformanceMarkdown,
  runPerformanceBenchmark,
  writePerformanceReport,
} from '../src/benchmark/performance.js';
import { parseDuration } from '../src/duration.js';

const CORPUS = resolve('benchmark/performance/v1/corpus.json');
const PROFILE = resolve('benchmark/performance/v1/profile.json');
const BASELINE = resolve('benchmark/performance/v1/baseline');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('review performance benchmark', () => {
  it('runs the fixed 20-file sequential baseline with bounded telemetry', async () => {
    const report = await runPerformanceBenchmark({
      corpusPath: CORPUS,
      profilePath: PROFILE,
      source: 'recorded',
      runs: 1,
    });

    expect(report).toMatchObject({
      version: 1,
      kind: 'review-performance',
      source: 'recorded',
      createdAt: null,
      corpus: {
        id: 'representative-20-file-pr',
        files: 20,
        categories: {
          typescript: 6,
          test: 4,
          configuration: 3,
          documentation: 3,
          'large-source': 2,
          'generated-like': 2,
        },
      },
      profile: {
        harness: 'pi',
        provider: 'openrouter',
        model: 'z-ai/glm-5.3-flash',
        indexProvider: 'cgc',
        indexProviderVersion: '0.5.7',
        execution: 'sequential',
      },
      quality: {
        passed: true,
        requiredFiles: 20,
        reviewedFiles: 20,
        omittedFiles: 0,
        invalidFiles: 0,
        findingsOnCleanCorpus: 0,
        incompleteCoverageRuns: 0,
        incompletePublicationRuns: 0,
      },
    });
    expect(report.targets.minimumLiveCorpusRuns).toBe(5);
    expect(report.runs).toHaveLength(1);
    const run = report.runs[0]!;
    expect(run.modeledReviewMs).toBe(1_208_000);
    expect(run.reviewWallMs).toBe(run.modeledReviewMs);
    expect(run.publicationMs).toBe(0);
    expect(run.stages).toMatchObject({
      checkoutFetchMs: null,
      runtimeSetupInstallMs: null,
      contextBundleBuildMs: 0,
      reviewBundleLoadMs: 0,
      harnessPreparationMs: 0,
      filePreparationMs: 0,
      modelMs: 1_208_000,
      validationMs: 0,
      writingMs: 0,
      summaryWritingMs: 0,
      publicationMs: 0,
    });
    expect(run.promptBytes).toBeGreaterThan(0);
    expect(run.estimatedInputTokens).toBeGreaterThan(0);
    expect(run.actualInputTokens).toBeNull();
    expect(run.costUsd).toBeNull();
    expect(run.files).toHaveLength(20);
    expect(run.files[0]).toMatchObject({
      fileId: '000001',
      path: 'src/cache.ts',
      queueWaitMs: 0,
      modelDurationMs: 55_000,
      processStartupMs: 0,
      timeToFirstTextMs: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      outcome: 'clean',
    });
    expect(run.files[1]?.queueWaitMs).toBe(55_000);
    expect(run.files.at(-1)?.queueWaitMs).toBe(1_133_000);

    expect(report.conditions.map((condition) => condition.id)).toEqual(['warm-index', 'cold-index']);
    for (const condition of report.conditions) {
      expect(condition.p95Ms).toBeGreaterThan(condition.targetMs);
      expect(condition.withinTarget).toBe(false);
      expect(condition.sloEligible).toBe(false);
      expect(condition.sloPassed).toBeNull();
      expect(condition.stageP50Ms.checkoutFetch).toBeGreaterThanOrEqual(0);
      expect(condition.stageP50Ms.dependencyInstallBuild).toBeGreaterThan(0);
      expect(condition.stageP50Ms.contextBundle).toBeGreaterThan(0);
      expect(condition.stageP50Ms.indexInstallation).toBeGreaterThan(0);
      expect(condition.stageP50Ms.indexRestore).toBeGreaterThan(0);
      expect(condition.stageP50Ms.indexQuery).toBeGreaterThan(0);
      expect(condition.stageP50Ms.publication).toBeGreaterThan(0);
    }
    expect(renderPerformanceMarkdown(report)).toContain('| warm-index | restored |');
    expect(renderPerformanceMarkdown(report)).toContain('not eligible');
    expect(JSON.stringify(report)).not.toContain('performance-benchmark-token');
  });

  it('matches the checked-in JSON and Markdown baseline', async () => {
    const report = await runPerformanceBenchmark({
      corpusPath: CORPUS,
      profilePath: PROFILE,
      source: 'recorded',
      runs: 1,
    });
    const expectedJson = JSON.parse(await readFile(join(BASELINE, 'report.json'), 'utf8')) as unknown;
    expect(report).toEqual(expectedJson);
    await expect(readFile(join(BASELINE, 'report.md'), 'utf8')).resolves.toBe(renderPerformanceMarkdown(report));
  });

  it('writes both report forms with no model text', async () => {
    const output = await mkdtemp(join(tmpdir(), 'redline-performance-report-'));
    temporaryDirectories.push(output);
    const report = await runPerformanceBenchmark({
      corpusPath: CORPUS,
      profilePath: PROFILE,
      source: 'recorded',
      runs: 1,
    });
    await writePerformanceReport(report, output);

    const json = await readFile(join(output, 'report.json'), 'utf8');
    const markdown = await readFile(join(output, 'report.md'), 'utf8');
    expect(JSON.parse(json)).toEqual(report);
    expect(markdown).toBe(renderPerformanceMarkdown(report));
    expect(json).not.toContain('base-value');
    expect(json).not.toContain('head-value');
    expect(json).not.toContain('"text"');
  });

  it('rejects a corpus that is not exactly 20 files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'redline-performance-corpus-'));
    temporaryDirectories.push(directory);
    const value = JSON.parse(await readFile(CORPUS, 'utf8')) as { files: unknown[] };
    value.files.pop();
    const path = join(directory, 'corpus.json');
    await writeFile(path, JSON.stringify(value));
    await expect(loadPerformanceCorpus(path)).rejects.toThrow('exactly 20 files');
  });

  it('rejects live execution that differs from the pinned profile', async () => {
    const unreachableFactory = (): HarnessExecutor => {
      throw new Error('executor must not be created for a configuration mismatch');
    };
    await expect(runPerformanceBenchmark({
      corpusPath: CORPUS,
      profilePath: PROFILE,
      source: 'live',
      runs: 5,
      live: {
        harness: 'pi',
        model: {
          provider: 'openrouter',
          endpoint: 'https://openrouter.ai/api/v1',
          model: 'different-model',
          auth: undefined,
        },
        credential: undefined,
        timeout: parseDuration('30m'),
        executorFactory: unreachableFactory,
      },
    })).rejects.toThrow('does not match the pinned profile');
  });

  it('loads bounded production index samples for both cache conditions', async () => {
    const profile = await loadPerformanceProfile(PROFILE);
    expect(profile.targets.minimumLiveCorpusRuns).toBe(5);
    expect(profile.conditions).toHaveLength(2);
    expect(profile.conditions[0]).toMatchObject({ id: 'warm-index', cache: 'restored' });
    expect(profile.conditions[0]?.samples).toHaveLength(3);
    expect(profile.conditions[1]).toMatchObject({ id: 'cold-index', cache: 'built' });
    expect(profile.conditions[1]?.samples).toHaveLength(5);
    expect(profile.conditions[1]?.samples.some((sample) => sample.indexMs > 0)).toBe(true);
  });
});
