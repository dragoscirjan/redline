import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessExecuteOptions, HarnessExecutor, HarnessPrompt, HarnessRun, HarnessSettings, PreparedHarness } from '../src/harness-executor/types.ts';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { runFileReviews } from '../src/review/runner.ts';
import { reviewFinding } from './helpers/finding.ts';
import { cleanReviewEnvironment, createBundleFixture, type BundleFixture } from './helpers/bundle.ts';

const clean = (fileId = '000001'): string => JSON.stringify({ version: 4, fileId, outcome: 'clean', findings: [], contextRequests: [] });
const omitted = (): string => JSON.stringify({ version: 4, fileId: '000001', outcome: 'omitted', reason: 'The source excerpt does not cover the entire file.', findings: [], contextRequests: [] });

class RetryExecutor implements HarnessExecutor {
  readonly harness = 'echo' as const;
  readonly calls: { fileId: string; timeoutMs: number; user: string }[] = [];
  settings?: HarnessSettings;
  private readonly answer: (index: number, fileId: string) => Partial<HarnessRun>;
  constructor(answer: (index: number, fileId: string) => Partial<HarnessRun>) { this.answer = answer; }
  async prepare(settings: HarnessSettings): Promise<PreparedHarness> {
    this.settings = settings;
    return { harness: 'echo', model: settings.model, description: 'retry fixture' };
  }
  async execute(_prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun> {
    const fileId = options?.invocation?.fileId ?? '';
    this.calls.push({ fileId, timeoutMs: options?.timeoutMs ?? 0, user: prompt.user });
    return { status: 'succeeded', harness: 'echo', text: clean(fileId), diagnostic: '', exitCode: 0, durationMs: 1,
      ...this.answer(this.calls.length - 1, fileId) };
  }
}

function environment(fixture: BundleFixture, retries: number | undefined = 3) {
  const parsed = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo')).review;
  if (parsed === undefined) throw new Error('missing fixture environment');
  return { ...parsed, ...(retries === undefined ? {} : { retries }), reviewConcurrency: 1,
    runTimeout: { minutes: 60, milliseconds: 3_600_000 } };
}

async function addSecondFile(fixture: BundleFixture): Promise<void> {
  const bundle = await loadReviewBundle(fixture.review, fixture.source);
  const second = { ...bundle.manifest.files[0], id: '000002', newPath: 'src/second.ts',
    diffFile: 'diffs/000002.diff', baseFile: 'base-files/000002' };
  await writeFile(join(fixture.review, 'manifest.json'), JSON.stringify({ ...bundle.manifest, files: [...bundle.manifest.files, second] }));
  await writeFile(join(fixture.review, second.diffFile), 'diff --git a/src/second.ts b/src/second.ts\n--- a/src/second.ts\n+++ b/src/second.ts\n@@ -1 +1 @@\n-old\n+new\n');
  await writeFile(join(fixture.review, second.baseFile), 'old\n');
  await writeFile(join(fixture.source, second.newPath), 'new\n');
}

describe('local caller-managed review retries', () => {
  it.each([
    ['invalid JSON', { text: 'not JSON' }],
    ['wrong target', { text: clean('000999') }],
    ['invalid schema', { text: JSON.stringify({ version: 4, fileId: '000001', outcome: 'clean' }) }],
    ['invalid evidence', { text: JSON.stringify({ version: 4, fileId: '000001', outcome: 'findings', contextRequests: [], findings: [reviewFinding({ evidence: 'not byte-identical' })] }) }],
    ['excluded scope', { text: JSON.stringify({ version: 4, fileId: '000001', outcome: 'findings', contextRequests: [], findings: [reviewFinding({ evidence: 'new', classification: 'risk' })] }) }],
    ['upstream error', { status: 'failed', text: '', retryable: true, diagnostic: 'Upstream Internal server error' }],
    ['transport error', { status: 'failed', text: '', retryable: true, diagnostic: 'connection reset' }],
  ] satisfies [string, Partial<HarnessRun>][])('recovers %s with a fresh validated attempt', async (_name, first) => {
    const f = await createBundleFixture();
    try {
      const executor = new RetryExecutor((index) => index === 0 ? first : {});
      const result = await runFileReviews({ environment: environment(f), executor });
      expect(executor.calls).toHaveLength(2);
      expect(executor.settings?.retryOwnership).toBe('caller');
      expect(result.records[0]).toMatchObject({ outcome: 'clean', durationMs: 2,
        attempts: [{ number: 1, outcome: 'omitted' }, { number: 2, outcome: 'clean' }] });
      expect(result.summary.retries).toMatchObject({ limit: 3, attempts: 2, retriedFiles: 1, recoveredFiles: 1 });
    } finally { await f.cleanup(); }
  });

  it('shares three additional retries across failure types and never fabricates clean coverage', async () => {
    const f = await createBundleFixture();
    try {
      const executor = new RetryExecutor((index) => index === 0
        ? { status: 'failed', retryable: true, diagnostic: 'HTTP 503', text: '' }
        : index === 1 ? { status: 'timed-out', text: '' } : { text: 'invalid JSON' });
      const result = await runFileReviews({ environment: environment(f), executor });
      expect(executor.calls).toHaveLength(4);
      expect(executor.calls.map((call) => call.timeoutMs)).toEqual([240_000, 240_000, 360_000, 360_000]);
      expect(result.records[0]).toMatchObject({ outcome: 'omitted', errorKind: 'invalid-output' });
      expect(result.records[0]?.attempts).toHaveLength(4);
      expect(result.summary.retries?.exhaustedFiles).toBe(1);
      expect(result.exitCode).toBe(1);
    } finally { await f.cleanup(); }
  });

  it('increases only timeout limits by two minutes on each retry', async () => {
    const f = await createBundleFixture();
    try {
      const executor = new RetryExecutor(() => ({ status: 'timed-out', text: '', durationMs: 240_000 }));
      const result = await runFileReviews({ environment: environment(f), executor });
      expect(executor.calls.map((call) => call.timeoutMs)).toEqual([240_000, 360_000, 480_000, 600_000]);
      expect(result.records[0]?.durationMs).toBe(960_000);
      expect(result.records[0]?.attempts?.map((attempt) => attempt.timeoutMs)).toEqual([240_000, 360_000, 480_000, 600_000]);
    } finally { await f.cleanup(); }
  });

  it('gives every file its initial attempt before starting retry rounds', async () => {
    const f = await createBundleFixture();
    try {
      await addSecondFile(f);
      const executor = new RetryExecutor((index) => index < 2 ? { text: 'bad' } : {});
      const result = await runFileReviews({ environment: environment(f), executor });
      expect(executor.calls.map((call) => call.fileId)).toEqual(['000001', '000002', '000001', '000002']);
      expect(result.records.map((record) => record.fileId)).toEqual(['000001', '000002']);
      expect(result.records.every((record) => record.outcome === 'clean')).toBe(true);
    } finally { await f.cleanup(); }
  });

  it('waits for active first-pass files before retrying and preserves the worker limit', async () => {
    const f = await createBundleFixture();
    let release = (): void => {}; let firstStarted = (): void => {}; let secondStarted = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = new Promise<void>((resolve) => { firstStarted = resolve; });
    const second = new Promise<void>((resolve) => { secondStarted = resolve; });
    try {
      await addSecondFile(f);
      const seen = new Set<string>();
      const executor = new RetryExecutor((_index, fileId) => {
        if (fileId === '000001' && !seen.has(fileId)) { seen.add(fileId); return { text: 'bad' }; }
        return {};
      });
      const execute = executor.execute.bind(executor); let active = 0; let maximumActive = 0;
      executor.execute = async (prepared, prompt, options) => {
        active += 1; maximumActive = Math.max(maximumActive, active);
        try {
          const result = await execute(prepared, prompt, options);
          if (options?.invocation?.fileId === '000002') { secondStarted(); await gate; } else firstStarted();
          return result;
        } finally { active -= 1; }
      };
      const running = runFileReviews({ environment: { ...environment(f), reviewConcurrency: 2 }, executor });
      await Promise.all([first, second]);
      expect(executor.calls).toHaveLength(2);
      release();
      const result = await running;
      expect(executor.calls).toHaveLength(3);
      expect(maximumActive).toBeLessThanOrEqual(2);
      expect(result.records.map((record) => record.fileId)).toEqual(['000001', '000002']);
      expect(result.records.every((record) => record.outcome === 'clean')).toBe(true);
    } finally { release(); await f.cleanup(); }
  });

  it.each([0, undefined])('keeps retries disabled for %s, including legacy Action environments', async (retries) => {
    const f = await createBundleFixture();
    try {
      const executor = new RetryExecutor(() => ({ text: 'bad' }));
      const env = environment(f, 0);
      if (retries === undefined) delete env.retries;
      const result = await runFileReviews({ environment: env, executor });
      expect(executor.calls).toHaveLength(1);
      expect(result.records[0]?.outcome).toBe('omitted');
      if (retries === undefined) {
        expect(result.summary.retries).toBeUndefined();
        expect(executor.settings?.retryOwnership).toBeUndefined();
      }
    } finally { await f.cleanup(); }
  });

  it.each([
    { status: 'failed', failureScope: 'run', retryable: false, diagnostic: 'HTTP 401 Invalid API key', text: '' },
    { status: 'failed', diagnostic: 'unknown local harness failure', text: '' },
  ] satisfies Partial<HarnessRun>[])('does not retry fatal or unclassified harness failures', async (failure) => {
    const f = await createBundleFixture();
    try {
      const executor = new RetryExecutor(() => failure);
      await runFileReviews({ environment: environment(f), executor });
      expect(executor.calls).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it('clamps an escalating retry to the remaining hard whole-run budget', async () => {
    const f = await createBundleFixture(); let now = 0;
    try {
      const executor = new RetryExecutor((index) => {
        now += index === 0 ? 240_000 : 60_000;
        return { status: 'timed-out', text: '', durationMs: index === 0 ? 240_000 : 60_000 };
      });
      const result = await runFileReviews({ environment: { ...environment(f), runTimeout: { minutes: 5, milliseconds: 300_000 } }, executor, now: () => now });
      expect(executor.calls.map((call) => call.timeoutMs)).toEqual([240_000, 60_000]);
      expect(result.records[0]?.errorKind).toBe('run-deadline-exhausted');
      expect(result.records[0]?.durationMs).toBe(300_000);
      expect(result.summary.executionBudget?.deadlineExhausted).toBe(true);
    } finally { await f.cleanup(); }
  });

  it('enriches an excerpt retry with captured source and invalidates reuse when that source changes', async () => {
    const f = await createBundleFixture({ headContent: ['new', ...Array.from({ length: 60 }, (_, index) => `tail ${index}`)].join('\n') + '\n' });
    try {
      const env = { ...environment(f), reuse: { directory: join(f.root, 'reuse'), namespace: 'local-retry-test' } };
      const executor = new RetryExecutor((index) => index === 0 ? { text: omitted() } : {});
      const result = await runFileReviews({ environment: env, executor });
      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[0]?.user).not.toContain('tail 59');
      expect(executor.calls[1]?.user).toContain('tail 59');
      expect(result.records[0]?.outcome).toBe('clean');
      const noCalls = new RetryExecutor(() => { throw new Error('validated retry result should be reused'); });
      expect((await runFileReviews({ environment: env, executor: noCalls })).records[0]?.execution).toBe('reused');
      const source = join(f.source, 'src/example.ts');
      await writeFile(source, (await readFile(source, 'utf8')).replace('tail 59', 'TAIL 59'));
      const changed = new RetryExecutor(() => ({}));
      expect((await runFileReviews({ environment: env, executor: changed })).records[0]?.execution).toBe('executed');
      expect(changed.calls).toHaveLength(1);
      const disabled = new RetryExecutor(() => ({}));
      await runFileReviews({ environment: { ...env, retries: 0 }, executor: disabled });
      expect(disabled.calls).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it('propagates cancellation without retrying or treating it as clean', async () => {
    const f = await createBundleFixture();
    try {
      const executor = new RetryExecutor(() => { throw new DOMException('cancelled', 'AbortError'); });
      await expect(runFileReviews({ environment: environment(f), executor })).rejects.toMatchObject({ name: 'AbortError' });
      expect(executor.calls).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it('redacts prior attempt reasons and persists them without prior raw answers', async () => {
    const f = await createBundleFixture();
    try {
      const env = environment(f);
      const executor = new RetryExecutor((index) => index === 0
        ? { status: 'failed', retryable: true, diagnostic: `HTTP 503 ${env.credential?.value}`, text: 'private failed response' } : {});
      await runFileReviews({ environment: env, executor });
      const record = await readFile(join(f.output, 'reviews/000001.json'), 'utf8');
      expect(record).not.toContain(env.credential?.value);
      expect(record).not.toContain('private failed response');
      expect(record).toContain('[redacted]');
    } finally { await f.cleanup(); }
  });
});
