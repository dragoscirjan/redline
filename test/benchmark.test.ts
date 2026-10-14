import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseBenchmarkFixture,
  renderBenchmarkMarkdown,
  runRecordedBenchmark,
  scoreBenchmarkCase,
  writeBenchmarkReport,
} from '../src/benchmark/benchmark.js';
import type { FileReviewRecord, PublishedFinding } from '../src/review/types.js';
import { publishedFinding } from './helpers/finding.js';

const CORPUS = resolve('benchmark/review-quality/v2');
const HISTORICAL_BASELINE = resolve('benchmark/review-quality/v1/baseline/report.json');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function scoringFixture() {
  return parseBenchmarkFixture({
    version: 2,
    id: 'scoring-case',
    title: 'Scoring case',
    kind: 'defect',
    baseRevision: 'a'.repeat(40),
    headRevision: 'b'.repeat(40),
    files: [{
      id: '000001',
      path: 'src/example.ts',
      status: 'M',
      base: 'old one\nold two\n',
      head: 'new one\nnew two\n',
      diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,2 @@\n-old one\n-old two\n+new one\n+new two\n',
    }],
    additionalHeadFiles: {},
    expectedIssues: [{
      id: 'root-cause',
      title: 'Expected root cause',
      locations: [{ path: 'src/example.ts', side: 'RIGHT', startLine: 1, endLine: 1 }],
    }],
    recordings: [
      {
        mode: 'file-only',
        responses: [{
          fileId: '000001',
          durationMs: 1,
          document: { version: 2, fileId: '000001', outcome: 'clean', findings: [] },
        }],
        judgments: [],
      },
      {
        mode: 'indexed-context',
        responses: [{
          fileId: '000001',
          durationMs: 1,
          document: { version: 2, fileId: '000001', outcome: 'clean', findings: [] },
        }],
        judgments: [],
        codeContext: {
          version: 1,
          provider: { id: 'cgc', version: '0.5.7' },
          repository: 'benchmark/redline',
          revision: 'b'.repeat(40),
          status: 'complete',
          files: [{ changedPath: 'src/example.ts', status: 'complete', related: [] }],
          diagnostics: [],
          timings: { installationMs: 0, restoreMs: 0, indexMs: 0, queryMs: 0, saveMs: null },
        },
      },
    ],
  });
}

function finding(line: number): PublishedFinding {
  return publishedFinding({
    id: `finding-${line}`,
    startLine: line,
    endLine: line,
    evidence: `new ${line === 1 ? 'one' : 'two'}`,
    impact: 'Wrong result.',
    fix: 'Correct it.',
    fixPrompt: 'Correct it.',
  });
}

function recordWithFindings(findings: readonly PublishedFinding[]): FileReviewRecord {
  return {
    version: 4,
    fileId: '000001',
    path: 'src/example.ts',
    status: 'M',
    harness: 'echo',
    model: 'recorded',
    codeContext: {
      status: 'disabled',
      provider: null,
      revision: null,
      relatedSpans: 0,
      sourceBytes: 0,
      reason: 'not-configured',
    },
    outcome: findings.length === 0 ? 'clean' : 'findings',
    findings,
    rejectedCandidates: [],
    durationMs: 1,
  };
}

describe('review-quality benchmark', () => {
  it('compares checked-in file-only and indexed-context recordings', async () => {
    const report = await runRecordedBenchmark(CORPUS);

    expect(report.version).toBe(2);
    expect(report.modes).toHaveLength(2);
    const fileOnly = report.modes[0]!;
    expect(fileOnly.mode).toBe('file-only');
    expect(fileOnly).toMatchObject({
      fixtures: 4,
      expectedIssues: 2,
      rootCauseMatches: 1,
      creditedIssues: 1,
      findings: 2,
      falsePositives: 1,
      cleanFixtures: 2,
      cleanFixturesWithFalsePositives: 1,
      claimedMatches: 1,
      validEvidenceMatches: 1,
      duplicateFindings: 0,
      reviewDurationMs: 39,
      codeContextCoverage: { disabled: 4, complete: 0, partial: 0, unsupported: 0, unavailable: 0 },
      codeContextSourceBytes: 0,
      indexTimings: null,
    });
    expect(fileOnly.promptBytes).toBeGreaterThan(0);

    const historical = JSON.parse(await readFile(HISTORICAL_BASELINE, 'utf8')) as {
      modes: Array<Record<string, unknown>>;
    };
    const historicalFileOnly = historical.modes[0]!;
    for (const field of [
      'fixtures',
      'expectedIssues',
      'rootCauseMatches',
      'creditedIssues',
      'findings',
      'falsePositives',
      'duplicateFindings',
      'reviewDurationMs',
    ]) {
      expect(fileOnly[field as keyof typeof fileOnly]).toBe(historicalFileOnly[field]);
    }

    const indexed = report.modes[1]!;
    expect(indexed).toMatchObject({
      mode: 'indexed-context',
      fixtures: 4,
      expectedIssues: 2,
      rootCauseMatches: 2,
      creditedIssues: 2,
      findings: 2,
      falsePositives: 0,
      duplicateFindings: 0,
      codeContextCoverage: { disabled: 0, complete: 4, partial: 0, unsupported: 0, unavailable: 0 },
      codeContextFilesWithContext: 2,
      codeContextRelatedSpans: 2,
      reviewDurationMs: 39,
      indexTimings: { installationMs: 0, restoreMs: 0, indexMs: 0, queryMs: 0, saveMs: null },
    });
    expect(indexed.codeContextSourceBytes).toBeGreaterThan(0);
    expect(indexed.promptBytes).toBeGreaterThan(fileOnly.promptBytes);
    expect(report.comparison).toMatchObject({
      rootCauseMatchesDelta: 1,
      creditedIssuesDelta: 1,
      falsePositivesDelta: -1,
      duplicateFindingsDelta: 0,
      reviewDurationMsDelta: 0,
    });

    const checkedInJson = JSON.parse(
      await readFile(join(CORPUS, 'comparison', 'report.json'), 'utf8'),
    ) as unknown;
    expect(checkedInJson).toEqual(report);
    await expect(readFile(join(CORPUS, 'comparison', 'report.md'), 'utf8')).resolves.toBe(
      renderBenchmarkMarkdown(report),
    );

    const fileOnlyCrossFile = fileOnly.cases.find((item) => item.fixtureId === 'cross-file-cache-collision');
    expect(fileOnlyCrossFile?.unmatchedIssueIds).toEqual(['cross-account-cache-collision']);
    const indexedCrossFile = indexed.cases.find((item) => item.fixtureId === 'cross-file-cache-collision');
    expect(indexedCrossFile?.creditedIssues).toBe(1);
    expect(indexedCrossFile?.codeContext).toMatchObject({ status: 'complete', relatedSpans: 1 });
  });

  it('writes stable JSON and Markdown reports', async () => {
    const output = await mkdtemp(join(tmpdir(), 'redline-benchmark-report-'));
    temporaryDirectories.push(output);
    const report = await runRecordedBenchmark(CORPUS);
    await writeBenchmarkReport(report, output);

    const json = JSON.parse(await readFile(join(output, 'report.json'), 'utf8')) as { version: number };
    expect(json.version).toBe(2);
    const markdown = await readFile(join(output, 'report.md'), 'utf8');
    expect(markdown).toBe(renderBenchmarkMarkdown(report));
    expect(markdown).toContain('Root-cause recall: 1/2 (50.0%)');
    expect(markdown).toContain('Root-cause recall: 2/2 (100.0%)');
    expect(markdown).toContain('## Comparison');
    expect(markdown).toContain('This report evaluates checked-in responses and human judgments.');
  });

  it.each([
    {
      name: 'keeps a root-cause match with bad evidence separate from false positives',
      findings: [finding(2)],
      judgments: [{ fileId: '000001', findingIndex: 0, expectedIssueId: 'root-cause' }],
      expected: { rootCauseMatches: 1, creditedIssues: 0, falsePositives: 0, duplicateFindings: 0 },
    },
    {
      name: 'counts a judged nonmatch only as a false positive',
      findings: [finding(1)],
      judgments: [{ fileId: '000001', findingIndex: 0, expectedIssueId: null }],
      expected: { rootCauseMatches: 0, creditedIssues: 0, falsePositives: 1, duplicateFindings: 0 },
    },
    {
      name: 'reports repeated matches as duplicates rather than false positives',
      findings: [finding(1), { ...finding(1), id: 'finding-duplicate' }],
      judgments: [
        { fileId: '000001', findingIndex: 0, expectedIssueId: 'root-cause' },
        { fileId: '000001', findingIndex: 1, expectedIssueId: 'root-cause' },
      ],
      expected: { rootCauseMatches: 1, creditedIssues: 1, falsePositives: 0, duplicateFindings: 1 },
    },
  ])('$name', ({ findings, judgments, expected }) => {
    const fixture = scoringFixture();
    const result = scoreBenchmarkCase(
      fixture,
      { ...fixture.recordings[0]!, judgments },
      [recordWithFindings(findings)],
      100,
    );
    expect(result).toMatchObject(expected);
  });

  it('rejects fixture diffs that do not produce the declared head source', () => {
    const fixture = scoringFixture();
    expect(() => parseBenchmarkFixture({
      ...fixture,
      files: [{ ...fixture.files[0]!, head: 'different\n' }],
    })).toThrow('diff does not produce its head source');
  });

  it('rejects accepted evidence ranges without a changed line', () => {
    const fixture = scoringFixture();
    expect(() => parseBenchmarkFixture({
      ...fixture,
      expectedIssues: [{
        ...fixture.expectedIssues[0]!,
        locations: [{ path: 'src/example.ts', side: 'RIGHT', startLine: 3, endLine: 3 }],
      }],
    })).toThrow('location contains no changed RIGHT line');
  });

  it('rejects additional source that replaces a changed file', () => {
    const fixture = scoringFixture();
    expect(() => parseBenchmarkFixture({
      ...fixture,
      additionalHeadFiles: { 'src/example.ts': 'replacement\n' },
    })).toThrow('additional head file duplicates changed path');
  });

  it('rejects indexed context for a different fixture revision', () => {
    const fixture = scoringFixture();
    const indexed = fixture.recordings[1]!;
    if (indexed.mode !== 'indexed-context') throw new Error('test fixture is missing indexed context');
    expect(() => parseBenchmarkFixture({
      ...fixture,
      recordings: [
        fixture.recordings[0],
        {
          ...indexed,
          codeContext: { ...indexed.codeContext, revision: 'c'.repeat(40) },
        },
      ],
    })).toThrow('must target the fixture head revision');
  });

  it('requires both comparison modes in every fixture', () => {
    const fixture = scoringFixture();
    expect(() => parseBenchmarkFixture({
      ...fixture,
      recordings: [fixture.recordings[0]],
    })).toThrow('must contain file-only and indexed-context recordings');
  });

  it('rejects fixture files reached through a symbolic link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-benchmark-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'redline-benchmark-outside-'));
    temporaryDirectories.push(root, outside);
    await mkdir(join(root, 'fixtures'));
    await writeFile(join(root, 'corpus.json'), JSON.stringify({ version: 2, fixtures: ['fixtures/case.json'] }));
    await writeFile(join(outside, 'case.json'), '{}');
    await symlink(join(outside, 'case.json'), join(root, 'fixtures', 'case.json'));

    await expect(runRecordedBenchmark(root)).rejects.toThrow('must not use symbolic links');
  });

  it('rejects clean fixtures that declare an expected defect', () => {
    expect(() => parseBenchmarkFixture({
      version: 2,
      id: 'invalid-clean',
      title: 'Invalid clean fixture',
      kind: 'clean',
      baseRevision: 'a'.repeat(40),
      headRevision: 'b'.repeat(40),
      files: [{
        id: '000001',
        path: 'src/example.ts',
        status: 'M',
        base: 'old\n',
        head: 'new\n',
        diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
      }],
      additionalHeadFiles: {},
      expectedIssues: [{
        id: 'unexpected-defect',
        title: 'Unexpected defect',
        locations: [{ path: 'src/example.ts', side: 'RIGHT', startLine: 1, endLine: 1 }],
      }],
      recordings: [{
        mode: 'file-only',
        responses: [{
          fileId: '000001',
          durationMs: 1,
          document: { version: 2, fileId: '000001', outcome: 'clean', findings: [] },
        }],
        judgments: [],
      }],
    })).toThrow('clean benchmark fixtures cannot declare expected issues');
  });
});
