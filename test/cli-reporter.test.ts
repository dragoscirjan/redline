import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewReport } from '../src/application/review.ts';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { runFileReviews } from '../src/review/runner.ts';
import type { PullRequestFinding } from '../src/review/types.ts';
import { FindingDiffReader, findingDiffExcerpt, MAX_EXCERPT_LINES } from '../src/local/finding-diff.ts';
import { CliReporter, terminalColors, terminalText } from '../src/local/reporter.ts';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.ts';
import { publishedFinding } from './helpers/finding.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
function finding(overrides: Partial<PullRequestFinding> = {}): PullRequestFinding {
  return { ...publishedFinding({ evidence: 'new' }), triggerFileId: '000001', triggerPath: 'src/example.ts', ...overrides };
}
async function reportFixture() {
  const fixture = await createBundleFixture(); cleanups.push(fixture.cleanup);
  const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo')).review!;
  const run = await runFileReviews({ environment });
  const report: ReviewReport = { review: run.review, summary: run.summary, outputDirectory: run.outputDirectory, omissions: [] };
  return { fixture, report };
}

describe('terminal progress and finding cards', () => {
  it('updates one manifest-ordered dot strip and distinguishes inert from failures', () => {
    const frames: string[] = []; const logs: string[] = [];
    const reporter = new CliReporter(() => {}, (line) => { logs.push(line); }, undefined, {
      terminal: { write: (text) => { frames.push(text); }, columns: () => 80, color: true },
    });
    reporter.progress({ kind: 'started' });
    reporter.progress({ kind: 'planned', files: [
      { fileId: '000001', reviewed: true }, { fileId: '000002', reviewed: true },
      { fileId: '000003', reviewed: false }, { fileId: '000004', reviewed: true },
    ] });
    reporter.progress({ kind: 'file-started', fileId: '000004' });
    reporter.progress({ kind: 'file-completed', fileId: '000004', outcome: 'findings' });
    reporter.progress({ kind: 'file-completed', fileId: '000002', outcome: 'omitted' });
    reporter.progress({ kind: 'file-completed', fileId: '000001', outcome: 'clean' });
    const final = frames.at(-1)!;
    expect(final).toContain('4/4');
    expect(final).toContain('\u001b[32m●\u001b[0m\u001b[33m!\u001b[0m\u001b[90m●\u001b[0m\u001b[31m●\u001b[0m');
    expect(frames.join('')).not.toContain('000004'); expect(logs).toEqual([]);
    expect(frames.every((frame) => !frame.includes('\n'))).toBe(true);
    reporter.progress({ kind: 'completed' }); expect(frames.at(-1)).toBe('\n');
  });

  it('bounds the live line across narrow terminals and resizing', () => {
    const frames: string[] = []; let width = 90;
    const reporter = new CliReporter(() => {}, () => {}, undefined, {
      terminal: { write: (text) => { frames.push(text); }, columns: () => width, color: false },
    });
    reporter.progress({ kind: 'planned', files: Array.from({ length: 2000 }, (_, index) => ({ fileId: String(index).padStart(6, '0'), reviewed: true })) });
    for (width of [90, 20, 6, 60]) {
      reporter.progress({ kind: 'file-started', fileId: '000001' });
      expect(Array.from(stripVTControlCharacters(frames.at(-1)!).replaceAll('\r', '')).length).toBeLessThan(width);
    }
  });

  it('respects TTY, NO_COLOR, explicit color selection, and dumb terminals', () => {
    expect(terminalColors('auto', false, {})).toBe(false);
    expect(terminalColors('auto', true, {})).toBe(true);
    expect(terminalColors('always', false, {})).toBe(true);
    expect(terminalColors('always', true, { NO_COLOR: '' })).toBe(false);
    expect(terminalColors('never', true, {})).toBe(false);
    expect(terminalColors('always', true, { TERM: 'dumb' })).toBe(false);
  });

  it('renders tab-indented excerpts and fixes as spaces while retaining control filtering and redaction', async () => {
    expect(terminalText('\tsecret\u001b[2J', 'secret')).toBe('    [redacted]?[2J');
    expect(terminalText('\t'.repeat(200))).toHaveLength(512);
    const { report } = await reportFixture(); const stdout: string[] = [];
    const issue = finding({ suggestion: '+\tcorrected' });
    const renderer = new CliReporter((line) => { stdout.push(line); }, () => {}, undefined, {
      readDiff: async () => ({ header: '@@ -1 +1 @@', lines: [{ left: null, right: 1, text: '+\tnew', cited: true }], truncated: false }),
    });
    await renderer.complete({ ...report, review: { ...report.review, findings: [issue] } });
    expect(stdout.join('\n')).toContain('+    new');
    expect(stdout.join('\n')).toContain('+    corrected');
    expect(stdout.join('\n')).not.toContain('+?');
    expect(stdout.join('\n')).not.toContain('\t');
  });

  it('prints grouped finding cards with authoritative changes and existing proposed fixes', async () => {
    const { fixture, report } = await reportFixture();
    const stdout: string[] = []; const stderr: string[] = [];
    const reader = new FindingDiffReader(fixture.review, fixture.source);
    const issue = finding({ suggestion: '-new\n+corrected' });
    const renderer = new CliReporter((line) => { stdout.push(line); }, (line) => { stderr.push(line); }, undefined, {
      readDiff: (item, revisions) => reader.read(item, revisions),
    });
    renderer.progress({ kind: 'started' });
    renderer.progress({ kind: 'file-completed', fileId: '000001', outcome: 'findings' });
    await renderer.complete({ ...report, review: { ...report.review, findings: [issue] },
      summary: { ...report.summary, findings: 1, files: [{ ...report.summary.files[0]!, outcome: 'findings', findingCount: 1 }] },
    });
    renderer.progress({ kind: 'completed' });
    const text = stdout.join('\n');
    expect(text).toContain('src/example.ts\n  MEDIUM 1-1 [RIGHT]');
    expect(text).toContain('Reviewed change'); expect(text).toContain('@@ -1 +1 @@');
    expect(text).toContain('+new'); expect(text).toContain('-old');
    expect(text).toContain('Proposed fix (not applied or test-verified)'); expect(text).toContain('+corrected');
    expect(text).not.toContain('\u001b'); expect(text).not.toContain('rawModelOutput');
    expect(stderr).toEqual(['Reviewing changes…']);
  });

  it.each(['completed', 'failed'] as const)('shows snapshot cleanup warnings after the %s outcome', async (outcome) => {
    const { report } = await reportFixture(); const stderr: string[] = [];
    const renderer = new CliReporter(() => {}, (line) => { stderr.push(line); });
    if (outcome === 'completed') await renderer.complete(report); else renderer.progress({ kind: 'failed' });
    renderer.progress({ kind: 'cleanup-failed' });
    expect(stderr).toContain('Warning: temporary snapshot cleanup failed; the review outcome is unchanged.');
  });

  it('keeps incomplete coverage explicit without scrolling per-file failure logs', async () => {
    const { report } = await reportFixture(); const stdout: string[] = []; const stderr: string[] = [];
    const renderer = new CliReporter((line) => { stdout.push(line); }, (line) => { stderr.push(line); });
    await renderer.complete({ ...report,
      summary: { ...report.summary, omittedFiles: 1, files: [{ ...report.summary.files[0]!, outcome: 'omitted' }] },
      omissions: [{ path: 'src/example.ts', errorKind: 'invalid-output' }],
    });
    renderer.progress({ kind: 'completed' });
    expect(stdout).toContain('Review incomplete');
    expect(stdout.join('\n')).toContain('0/1 required files completed; 1 failed; 0 inert');
    expect(stderr).toEqual(['Failed reviews: 1 invalid-output. File details are in the artifacts.']);
    expect(stdout.join('\n') + stderr.join('\n')).not.toContain('redline: completed');
  });

  it('groups multiple findings once per file and bounds/redacts original and proposed code', async () => {
    const { report } = await reportFixture(); const stdout: string[] = [];
    const issues = [
      finding({ suggestion: Array.from({ length: 25 }, () => '+secret-token\u001b[2J').join('\n') }),
      finding({ id: 'f-second', title: 'Second finding in this file' }),
    ];
    const renderer = new CliReporter((line) => { stdout.push(line); }, () => {}, 'secret-token', {
      readDiff: async () => ({
        header: '@@ -1 +1 @@ secret-token',
        lines: [{ left: null, right: 1, text: '+secret-token\u001b]52;c;payload', cited: true }],
        truncated: false,
      }),
    });
    await renderer.complete({ ...report, review: { ...report.review, findings: issues },
      summary: { ...report.summary, findings: 2, files: [{ ...report.summary.files[0]!, outcome: 'findings', findingCount: 2 }] },
    });
    expect(stdout.filter((line) => line === 'src/example.ts')).toHaveLength(1);
    expect(stdout).toContain('Status: x');
    expect(stdout.join('\n')).toContain('… truncated; full text is in the artifacts.');
    expect(stdout.join('\n')).toContain('[redacted]');
    expect(stdout.join('\n')).not.toContain('secret-token');
    expect(stdout.join('\n')).not.toContain('\u001b');
    expect(stdout.filter((line) => line.startsWith('    +'))).toHaveLength(20);
  });

  it('closes the live line on failure without marking outstanding files clean or inert', () => {
    const frames: string[] = []; const errors: string[] = [];
    const renderer = new CliReporter(() => {}, (line) => { errors.push(line); }, undefined, {
      terminal: { write: (text) => { frames.push(text); }, columns: () => 80, color: false },
    });
    renderer.progress({ kind: 'planned', files: [{ fileId: '000001', reviewed: true }] });
    renderer.progress({ kind: 'file-started', fileId: '000001' });
    renderer.progress({ kind: 'failed' });
    expect(frames.at(-1)).toBe('\n');
    expect(frames.at(-2)).toContain('[o]');
    expect(errors).toEqual(['Review interrupted or failed; coverage is incomplete.']);
  });

  it('does not invent unavailable context or a missing fix and sanitizes terminal data', async () => {
    const { report } = await reportFixture(); const stdout: string[] = [];
    const issue = finding({ title: 'bad\u001b[2J secret-token', impact: 'source\r\nsecret-token' });
    const renderer = new CliReporter((line) => { stdout.push(line); }, () => {}, 'secret-token');
    await renderer.complete({ ...report, review: { ...report.review, findings: [issue] } });
    expect(stdout.join('\n')).toContain('Excerpt unavailable');
    expect(stdout.join('\n')).toContain('Proposed fix: none supplied.');
    expect(stdout.join('\n')).toContain('[redacted]');
    expect(stdout.join('\n')).not.toContain('secret-token'); expect(stdout.join('\n')).not.toContain('\u001b');
  });
});

describe('bounded authoritative finding excerpts', () => {
  it('maps both sides and preserves old/new numbers and cited markers', () => {
    const diff = 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -10,2 +10,2 @@ fn\n context\n-old\n+new\n';
    const right = findingDiffExcerpt(diff, finding({ startLine: 11, endLine: 11 }));
    const left = findingDiffExcerpt(diff, finding({ side: 'LEFT', startLine: 11, endLine: 11, evidence: 'old' }));
    expect(right?.lines.find((line) => line.cited)).toEqual({ text: '+new', left: null, right: 11, cited: true });
    expect(left?.lines.find((line) => line.cited)).toEqual({ text: '-old', left: 11, right: null, cited: true });
    expect(findingDiffExcerpt(diff, finding({ startLine: 11, endLine: 11, evidence: 'guessed' }))).toBeUndefined();
  });

  it('selects the matching hunk, bounds long spans, and marks clipping', () => {
    const diff = '@@ -1 +1 @@\n-old\n+first\n@@ -10,60 +10,60 @@\n' + Array.from({ length: 60 }, (_, index) => `-old${index}\n+new${index}`).join('\n');
    const excerpt = findingDiffExcerpt(diff, finding({ startLine: 10, endLine: 69, evidence: 'new0' }));
    expect(excerpt?.header).toBe('@@ -10,60 +10,60 @@');
    expect(excerpt?.lines.length).toBeLessThanOrEqual(MAX_EXCERPT_LINES);
    expect(excerpt?.lines.some((line) => line.cited)).toBe(true); expect(excerpt?.truncated).toBe(true);
    expect(findingDiffExcerpt('x'.repeat(2 * 1024 * 1024 + 1), finding())).toBeUndefined();
  });

  it('requires matching captured revisions, file identity, and a regular bounded diff', async () => {
    const { fixture, report } = await reportFixture();
    const reader = new FindingDiffReader(fixture.review, fixture.source);
    expect(await reader.read(finding(), report.review)).toBeDefined();
    expect(await reader.read(finding(), { base: report.review.base, head: 'c'.repeat(40) })).toBeUndefined();
    expect(await reader.read(finding({ triggerPath: '../outside' }), report.review)).toBeUndefined();
    const target = join(fixture.root, 'temporary-sentinel'); await writeFile(target, 'must not be used as a diff');
    await rm(join(fixture.review, 'diffs/000001.diff'));
    await symlink(target, join(fixture.review, 'diffs/000001.diff'), 'file');
    expect(await new FindingDiffReader(fixture.review, fixture.source).read(finding(), report.review)).toBeUndefined();
  });
});
