import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { runFileReviews } from '../src/review/runner.ts';
import type { HarnessExecuteOptions, HarnessExecutor, HarnessPrompt, HarnessRun, PreparedHarness } from '../src/harness-executor/types.ts';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { FileReviewValidator } from '../src/review/report.ts';
import { loadReviewReuseCache } from '../src/review/reuse.ts';
import { VERIFICATION_TIMEOUT_MS } from '../src/review/runner.ts';
import { MAX_REVIEW_REASON_CHARS } from '../src/review/types.ts';
import {
  cleanReviewEnvironment,
  createBundleFixture,
  BASE_SHA,
  HEAD_SHA,
  type BundleFixture,
} from './helpers/bundle.ts';
import { reviewFinding } from './helpers/finding.ts';

/** Scripted executor double: answers prompts from a queue of runs. */
class ScriptedExecutor implements HarnessExecutor {
  readonly harness = 'echo' as const;
  readonly prompts: HarnessPrompt[] = [];
  readonly options: (HarnessExecuteOptions | undefined)[] = [];
  #runs: HarnessRun[] = [];

  script(runs: Array<Partial<HarnessRun>>): void {
    this.#runs = runs.map((run) => ({
      status: 'succeeded',
      harness: 'echo',
      exitCode: 0,
      text: '',
      diagnostic: '',
      durationMs: 1,
      ...run,
    }));
  }

  async prepare(): Promise<PreparedHarness> {
    return { harness: 'echo', model: { provider: 'mock', endpoint: 'http://x', model: 'test-model' }, description: 'scripted test double' };
  }

  async execute(_prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun> {
    this.prompts.push(prompt);
    this.options.push(options);
    const next = this.#runs.shift();
    if (next === undefined) throw new Error('scripted executor ran out of scripted runs');
    return next;
  }
}

function reviewDocument(value: object): string {
  return JSON.stringify(value);
}

function reuseReviewEnvironment(fixture: BundleFixture): NodeJS.ProcessEnv {
  return {
    ...cleanReviewEnvironment(fixture, 'echo'),
    REDLINE_REUSE_DIR: join(fixture.root, 'review-reuse'),
    REDLINE_REUSE_NAMESPACE: 'owner/repository#42',
  };
}

async function createMultiFileFixture(diffPadding: readonly number[]): Promise<BundleFixture> {
  const fixture = await createBundleFixture();
  const files = diffPadding.map((padding, index) => {
    const id = String(index + 1).padStart(6, '0');
    const path = `src/file-${id}.ts`;
    const oldLine = `old-${id}`;
    const newLine = `new-${id}-${'x'.repeat(padding)}`;
    return {
      id,
      status: 'M',
      oldPath: path,
      newPath: path,
      similarity: null,
      additions: 1,
      deletions: 1,
      binary: false,
      reviewed: true,
      diffFile: `diffs/${id}.diff`,
      baseFile: `base-files/${id}`,
      oldLine,
      newLine,
    } as const;
  });
  await Promise.all(files.flatMap((file) => [
    writeFile(
      join(fixture.review, file.diffFile),
      `diff --git a/${file.newPath} b/${file.newPath}\n--- a/${file.newPath}\n+++ b/${file.newPath}\n@@ -1 +1 @@\n-${file.oldLine}\n+${file.newLine}\n`,
    ),
    writeFile(join(fixture.review, file.baseFile), `${file.oldLine}\n`),
    writeFile(join(fixture.source, file.newPath), `${file.newLine}\n`),
  ]));
  await writeFile(join(fixture.review, 'manifest.json'), JSON.stringify({
    version: 1,
    base: BASE_SHA,
    head: HEAD_SHA,
    files: files.map(({ oldLine: _oldLine, newLine: _newLine, ...file }) => file),
  }));
  return fixture;
}

class ConcurrentExecutor implements HarnessExecutor {
  readonly harness = 'echo' as const;
  readonly started: string[] = [];
  active = 0;
  maximumActive = 0;

  async prepare(): Promise<PreparedHarness> {
    return { harness: 'echo', model: { provider: 'mock', endpoint: 'http://x', model: 'test-model' }, description: 'concurrency test double' };
  }

  async execute(
    _prepared: PreparedHarness,
    _prompt: HarnessPrompt,
    options?: HarnessExecuteOptions,
  ): Promise<HarnessRun> {
    const fileId = options?.invocation?.fileId;
    if (fileId === undefined || options?.invocation?.path !== `src/file-${fileId}.ts`) {
      throw new Error('concurrency test invocation has no matching file identity');
    }
    this.started.push(fileId);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    options?.onOutputLine?.({ stream: 'stdout', kind: 'text', line: `chunk-${fileId}` });
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5 + (7 - Number(fileId)) * 2));
      return {
        status: 'succeeded',
        harness: 'echo',
        exitCode: 0,
        text: reviewDocument({ version: 4, fileId, outcome: 'clean', findings: [], contextRequests: [] }),
        diagnostic: '',
        durationMs: 10,
      };
    } finally {
      this.active -= 1;
    }
  }
}

async function writeCodeContext(fixture: BundleFixture, value?: object): Promise<string> {
  const path = join(fixture.root, 'code-context.json');
  await writeFile(path, JSON.stringify(value ?? {
    version: 2,
    provider: { id: 'cgc', version: '0.5.7' },
    repository: 'owner/repository',
    revision: HEAD_SHA,
    status: 'complete',
    files: [
      {
        changedPath: 'src/example.ts',
        status: 'complete',
        related: [
          { path: 'src/related.ts', startLine: 1, endLine: 2, reason: 'incoming CALLS relationship' },
        ],
      },
    ],
    diagnostics: [],
    timings: { installationMs: 1, restoreMs: 2, validationMs: 3, indexMs: 4, queryMs: 5, saveMs: null },
  }));
  return path;
}

describe('runFileReviews', () => {
  it('stops starting files at the whole-review deadline and records deterministic omissions', async () => {
    const fixture = await createMultiFileFixture([10, 20, 30]);
    try {
      const parsed = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      let currentTimeMs = 0;
      let calls = 0;
      const executor: HarnessExecutor = {
        harness: 'echo',
        async prepare() {
          return {
            harness: 'echo',
            model: { provider: 'mock', endpoint: 'http://x', model: 'test-model' },
            description: 'deadline test double',
          };
        },
        async execute(_prepared, _prompt, options) {
          calls += 1;
          currentTimeMs = 1_000;
          const fileId = options?.invocation?.fileId ?? '000000';
          return {
            status: 'succeeded', harness: 'echo', exitCode: 0, diagnostic: '', durationMs: 1_000,
            text: reviewDocument({ version: 4, fileId, outcome: 'clean', findings: [], contextRequests: [] }),
          };
        },
      };
      const result = await runFileReviews({
        environment: {
          ...parsed.review!,
          timeout: { minutes: 1, milliseconds: 500 },
          runTimeout: { minutes: 1, milliseconds: 1_000 },
          reviewConcurrency: 1,
        },
        executor,
        now: () => currentTimeMs,
      });

      expect(calls).toBe(1);
      expect(result.exitCode).toBe(0);
      expect(result.records.map((record) => record.outcome)).toEqual(['clean', 'omitted', 'omitted']);
      expect(result.records.slice(1).every(
        (record) => record.errorKind === 'run-deadline-exhausted'
          && record.reason === 'whole-review deadline exhausted before this file started',
      )).toBe(true);
      expect(result.summary.executionBudget).toEqual({
        version: 1,
        fileTimeoutMs: 500,
        runTimeoutMs: 1_000,
        elapsedMs: 1_000,
        deadlineExhausted: true,
        deadlineOmittedFiles: 2,
      });
      expect(await readFile(join(fixture.output, 'reviews/summary.md'), 'utf8')).toContain(
        '**Deadline result:** exhausted; 2 files omitted, 1000 ms elapsed',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('caps a file invocation at the remaining whole-review budget', async () => {
    const fixture = await createBundleFixture();
    try {
      const parsed = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const result = await runFileReviews({
        environment: {
          ...parsed.review!,
          timeout: { minutes: 1, milliseconds: 2_000 },
          runTimeout: { minutes: 1, milliseconds: 1_000 },
        },
        executor,
        now: () => 0,
      });

      expect(executor.options[0]?.timeoutMs).toBe(1_000);
      expect(result.summary.executionBudget?.deadlineExhausted).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('labels a harness timeout caused by the remaining run budget as deadline exhaustion', async () => {
    const fixture = await createBundleFixture();
    try {
      const parsed = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([{ status: 'timed-out', diagnostic: 'process exceeded timeout', durationMs: 1_000 }]);
      const result = await runFileReviews({
        environment: {
          ...parsed.review!,
          timeout: { minutes: 1, milliseconds: 2_000 },
          runTimeout: { minutes: 1, milliseconds: 1_000 },
        },
        executor,
        now: () => 0,
      });

      expect(executor.options[0]?.timeoutMs).toBe(1_000);
      expect(result.records[0]).toMatchObject({
        outcome: 'omitted',
        errorKind: 'run-deadline-exhausted',
        reason: 'whole-review deadline exhausted during model execution',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops queued work after a shared fatal harness error and writes honest redacted omissions', async () => {
    const fixture = await createMultiFileFixture([10, 20, 30, 40, 50, 60]);
    try {
      const parsed = parseReviewEnvironment({ ...cleanReviewEnvironment(fixture, 'echo'), REDLINE_REVIEW_CONCURRENCY: '1' });
      const executor = new ScriptedExecutor();
      executor.script(Array.from({ length: 6 }, () => ({ status: 'failed', text: '', failureScope: 'run', diagnostic: '401 Invalid API key FATAL_FIXTURE_KEY' })));
      const result = await runFileReviews({ environment: { ...parsed.review!, credential: { provider: 'mock', value: 'FATAL_FIXTURE_KEY' } }, executor });
      expect(executor.prompts).toHaveLength(1);
      expect(result.records.map(r => r.execution)).toEqual(['executed', ...Array(5).fill('not-started')]);
      expect(result.summary.reuse).toMatchObject({ executedFiles: 1, reusedFiles: 0 });
      expect(result.summary.omittedFiles).toBe(6); expect(result.exitCode).toBe(1);
      expect(result.review.coverage.files.status).toBe('incomplete');
      for (const r of result.records) {
        expect(r.errorKind).toBe('harness-failed'); expect(r.reason).toContain('[redacted]');
        const saved = await readFile(join(fixture.output, 'reviews', r.fileId + '.json'), 'utf8');
        expect(saved).not.toContain('FATAL_FIXTURE_KEY');
        if (r.execution === 'not-started') { expect(r.durationMs).toBe(0); expect(r.reason).toContain('not started'); }
      }
    } finally { await fixture.cleanup(); }
  });

  it('settles in-flight reviews after fatal failure without launching the next wave', async () => {
    const fixture = await createMultiFileFixture(Array(12).fill(10));
    try {
      const parsed = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      let calls = 0; let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const executor: HarnessExecutor = {
        harness: 'echo', prepare: async () => ({ harness: 'echo', model: parsed.review!.model, description: 'fatal barrier fixture' }),
        execute: async (_prepared, _prompt, options) => {
          const first = ++calls === 1;
          if (calls === 4) release();
          await gate;
          return first ? { status: 'failed', harness: 'echo', exitCode: 0, text: '', diagnostic: '401 Invalid API key', durationMs: 1, failureScope: 'run' }
            : { status: 'succeeded', harness: 'echo', exitCode: 0, diagnostic: '', durationMs: 1,
                text: reviewDocument({ version: 4, fileId: options!.invocation!.fileId, outcome: 'clean', reason: 'No defects.', contextRequests: [], findings: [] }) };
        },
      };
      const result = await runFileReviews({ environment: parsed.review!, executor });
      expect(calls).toBe(4);
      expect(result.records.filter(r => r.execution === 'not-started')).toHaveLength(8);
      expect(result.records.filter(r => r.outcome === 'clean')).toHaveLength(3);
      expect(result.summary.reuse?.executedFiles).toBe(4);
      expect(result.records.map(r => r.fileId)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(6, '0')));
      expect(result.summary.omittedFiles).toBe(9); expect(result.exitCode).toBe(1);
    } finally { await fixture.cleanup(); }
  });

  it('keeps independent file errors local rather than stopping the run', async () => {
    const fixture = await createMultiFileFixture([10, 20, 30]);
    try {
      const parsed = parseReviewEnvironment({ ...cleanReviewEnvironment(fixture, 'echo'), REDLINE_REVIEW_CONCURRENCY: '1' });
      const executor = new ScriptedExecutor();
      executor.script([
        { status: 'failed', text: '', failureScope: 'file', diagnostic: '400 Context length exceeded' },
        ...['000002', '000003'].map(fileId => ({ text: reviewDocument({ version: 4, fileId, outcome: 'clean', contextRequests: [], findings: [] }) })),
      ]);
      const result = await runFileReviews({ environment: parsed.review!, executor });
      expect(executor.prompts).toHaveLength(3);
      expect(result.records.map(r => r.outcome)).toEqual(['omitted', 'clean', 'clean']);
      expect(result.records.some(r => r.execution === 'not-started')).toBe(false);
      expect(result.summary.harnessFailure?.scope).toBe('file');
    } finally { await fixture.cleanup(); }
  });

  it('bounds active model calls, starts largest diffs first, and restores manifest order', async () => {
    const fixture = await createMultiFileFixture([10, 600, 100, 500, 200, 400]);
    try {
      const parsed = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ConcurrentExecutor();
      const starts: string[] = [];
      const output: Array<{ fileId: string; path: string; line: string }> = [];
      const result = await runFileReviews({
        environment: parsed.review!,
        executor,
        onFileStart: (file) => starts.push(file.fileId),
        onHarnessOutput: (event) => output.push({ fileId: event.fileId, path: event.path, line: event.line }),
      });

      expect(executor.maximumActive).toBe(4);
      expect(starts.slice(0, 4)).toEqual(['000002', '000004', '000006', '000005']);
      expect(result.records.map((record) => record.fileId)).toEqual([
        '000001', '000002', '000003', '000004', '000005', '000006',
      ]);
      expect(output).toHaveLength(6);
      for (const event of output) {
        expect(event.line).toBe(`chunk-${event.fileId}`);
        expect(event.path).toBe(`src/file-${event.fileId}.ts`);
      }
      expect(result.review.coverage.files).toMatchObject({ status: 'completed', required: true, omitted: [] });
      expect(result.review.coverage.files.considered).toHaveLength(6);
    } finally {
      await fixture.cleanup();
    }
  });

  it('mixes large and small tasks without changing bounded concurrency or artifact order', async () => {
    const fixture = await createMultiFileFixture([10, 600, 100, 500, 200, 400]);
    try {
      const parsed = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ConcurrentExecutor(); const starts: string[] = [];
      const workload: unknown[] = [];
      const result = await runFileReviews({ environment: { ...parsed.review!, scheduling: 'mixed' }, executor,
        onFileStart: (file) => starts.push(file.fileId), onWorkload: (value) => workload.push(value) });
      expect(executor.maximumActive).toBe(4);
      expect(starts.slice(0, 4)).toEqual(['000002', '000001', '000004', '000003']);
      expect(result.records.map((record) => record.fileId)).toEqual(['000001', '000002', '000003', '000004', '000005', '000006']);
      expect(workload).toEqual([expect.objectContaining({ files: 6, workers: 4, scheduling: 'mixed' })]);
    } finally { await fixture.cleanup(); }
  });

  it('keeps manifest traversal and one active call when concurrency is one', async () => {
    const fixture = await createMultiFileFixture([10, 600, 100]);
    try {
      const parsed = parseReviewEnvironment({
        ...cleanReviewEnvironment(fixture, 'echo'),
        REDLINE_REVIEW_CONCURRENCY: '1',
      });
      const executor = new ConcurrentExecutor();
      const starts: string[] = [];
      const result = await runFileReviews({
        environment: parsed.review!,
        executor,
        onFileStart: (file) => starts.push(file.fileId),
      });

      expect(executor.maximumActive).toBe(1);
      expect(starts).toEqual(['000001', '000002', '000003']);
      expect(result.records.map((record) => record.fileId)).toEqual(starts);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps candidate verification serial to preserve the shared follow-up budget', async () => {
    const fixture = await createMultiFileFixture([10, 600, 100]);
    try {
      const parsed = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ConcurrentExecutor();
      const starts: string[] = [];
      await runFileReviews({
        environment: parsed.review!,
        executor,
        verifyCandidates: true,
        onFileStart: (file) => starts.push(file.fileId),
      });

      expect(executor.maximumActive).toBe(1);
      expect(starts).toEqual(['000001', '000002', '000003']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('passes only action-resolved source and counts duplicate requests once', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src/related.ts'), 'export const related = true;\n');
      const contextPath = await writeCodeContext(fixture, {
        version: 2, provider: { id: 'cgc', version: '0.5.7' },
        repository: 'owner/repository', revision: HEAD_SHA, status: 'complete',
        files: [{ changedPath: 'src/example.ts', status: 'complete', related: [{
          path: 'src/related.ts', startLine: 1, endLine: 1, reason: 'incoming CALLS',
        }] }],
        diagnostics: [], timings: { installationMs: 0, restoreMs: 0, validationMs: 0, indexMs: 0, queryMs: 0, saveMs: null },
      });
      const environment = parseReviewEnvironment({ ...cleanReviewEnvironment(fixture, 'echo'),
        REDLINE_CODE_CONTEXT: contextPath, REDLINE_CODE_CONTEXT_REPOSITORY: 'owner/repository',
      });
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const candidate = reviewFinding({ evidence: 'new' });
      const finding = new FileReviewValidator(
        file, await readFile(join(fixture.review, file.diffFile), 'utf8'), 'defects',
      ).validateFinding(candidate);
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 4, fileId: file.id, outcome: 'findings', findings: [candidate],
          contextRequests: [{ candidateIndex: 0, direction: 'incoming' },
            { candidateIndex: 0, direction: 'incoming' }] }) },
        { text: reviewDocument({ version: 1, fileId: file.id, results: [{
          candidateId: finding.id, disposition: 'confirmed', reason: 'Captured caller establishes reachability.',
          citations: [{ role: 'impact-path', revision: HEAD_SHA, path: 'src/related.ts',
            startLine: 1, endLine: 1, evidence: 'export const related = true;' }],
        }] }) },
      ]);
      const seen: string[] = [];
      const result = await runFileReviews({ environment: environment.review!, executor, verifyCandidates: true,
        followUpExecutor: async (requests) => {
          seen.push(requests.requests[0]?.changedPath ?? 'missing');
          expect(requests).toMatchObject({ repository: 'owner/repository', base: BASE_SHA, head: HEAD_SHA });
          expect(requests.requests[0]).toMatchObject({
            candidateId: finding.id, direction: 'incoming', depth: 1, fanOut: 8, resultLimit: 8,
          });
          return JSON.stringify({ version: 1, repository: requests.repository,
            base: requests.base, head: requests.head, provider: { id: 'cgc', version: '0.5.7' },
            snapshot: BASE_SHA, results: [{ requestId: requests.requests[0]?.id,
              status: 'complete', reason: null, durationMs: 5, spans: [{ path: 'src/related.ts',
                revision: HEAD_SHA, startLine: 1, endLine: 1, evidence: 'export const related = true;',
                relationship: 'related-symbol-calls-changed-code' }] }] });
        },
      });
      expect(seen).toEqual(['src/example.ts']);
      expect(executor.prompts[0]?.system).toContain('"followUp": "action-owned"');
      expect(executor.prompts[1]?.user).toContain('"followUp"');
      expect(result.records[0]).toMatchObject({
        followUp: { status: 'completed', requested: 1, completed: 1 },
        verification: { status: 'completed' }, outcome: 'findings',
      });
      expect(result.records[0]?.followUp?.durationMs).toBeGreaterThanOrEqual(5);
      expect(result.records[0]?.findings[0]?.supportingEvidence).toContainEqual(expect.objectContaining({
        path: 'src/related.ts', evidence: 'export const related = true;',
      }));
      expect(result.review.coverage.followUp).toMatchObject({ status: 'completed', required: true });
      expect(await readFile(join(fixture.output, 'reviews/follow-up/000001.json'), 'utf8'))
        .toContain('related-symbol-calls-changed-code');
    } finally {
      await fixture.cleanup();
    }
  });

  it('publishes supported v4 findings with no follow-up under the verifier-off policy', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([{ text: reviewDocument({ version: 4, fileId: '000001', outcome: 'findings',
        findings: [reviewFinding({ evidence: 'new' })], contextRequests: [],
      }) }]);
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(executor.prompts[0]?.system).toContain('"followUp": "unavailable"');
      expect(executor.prompts[0]?.system).toContain('always return `[]`');
      expect(result.records[0]?.outcome).toBe('findings');
      expect(result.records[0]?.followUp).toBeUndefined();
      expect(result.review.findings).toHaveLength(1);
      expect(result.review.verdict.status).toBe('blocked');
    } finally {
      await fixture.cleanup();
    }
  });

  it('never publishes a v4 candidate that asks for follow-up while the verifier gate is off', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([{ text: reviewDocument({ version: 4, fileId: '000001', outcome: 'findings',
        findings: [reviewFinding({ evidence: 'new' })],
        contextRequests: [{ candidateIndex: 0, direction: 'incoming' }],
      }) }]);
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(result.records[0]).toMatchObject({ outcome: 'omitted', findings: [],
        followUp: { status: 'incomplete', requested: 1 } });
      expect(result.review.findings).toEqual([]);
      expect(result.review.coverage.followUp).toMatchObject({ status: 'incomplete', required: true });
      expect(result.review.verdict.status).toBe('inconclusive');
      expect(executor.prompts).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('records required incomplete coverage when action-owned follow-up is unavailable', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 4, fileId: '000001', outcome: 'findings',
          findings: [reviewFinding({ evidence: 'new' })],
          contextRequests: [{ candidateIndex: 0, direction: 'incoming' }] }) },
        { text: '{"version":1,"fileId":"000001","results":[]}' },
      ]);
      let providerCalls = 0;
      const result = await runFileReviews({
        environment: environment.review!,
        executor,
        verifyCandidates: true,
        followUpExecutor: async () => {
          providerCalls += 1;
          return '';
        },
      });
      expect(providerCalls).toBe(0);
      expect(result.records[0]).toMatchObject({
        followUp: {
          status: 'incomplete', requested: 1, completed: 0, durationMs: 0,
          reason: 'follow-up provider is not configured',
        },
        outcome: 'omitted', findings: [],
      });
      expect(result.review.limitations).toContainEqual(expect.objectContaining({
        code: 'follow-up-incomplete', required: true,
      }));
      expect(result.review.verdict.status).toBe('inconclusive');
    } finally {
      await fixture.cleanup();
    }
  });

  it('skips the verifier for a clean file while recording required verification coverage', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([{ text: reviewDocument({ version: 3, fileId: '000001', outcome: 'clean', findings: [] }) }]);
      const result = await runFileReviews({ environment: environment.review!, executor, verifyCandidates: true });
      expect(executor.prompts).toHaveLength(1);
      expect(result.records[0]?.verification?.status).toBe('not-applicable');
      expect(result.review.coverage.verification).toMatchObject({ status: 'completed', required: true });
      expect(result.review.verdict.status).toBe('mergeable');
    } finally {
      await fixture.cleanup();
    }
  });

  it('verifies a finding in a fresh bounded call before publication and redacts the verifier result', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const candidate = reviewFinding({ evidence: 'new' });
      const finding = new FileReviewValidator(
        file, await readFile(join(fixture.review, file.diffFile), 'utf8'), 'defects',
      ).validateFinding(candidate);
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 3, fileId: file.id, outcome: 'findings', findings: [candidate] }) },
        { text: `\`\`\`json\n${JSON.stringify({
          version: 1,
          fileId: file.id,
          results: [{
            candidateId: finding.id,
            disposition: 'confirmed',
            reason: 'Rechecked test-key against the changed line.',
            citations: [{
              role: 'contract', revision: HEAD_SHA, path: 'src/example.ts',
              startLine: 1, endLine: 1, evidence: 'new',
            }],
          }],
        })}\n\`\`\`` },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor, verifyCandidates: true });
      expect(executor.prompts).toHaveLength(2);
      expect(executor.prompts[1]?.system).toContain('redline-verification/v3');
      expect(executor.options[1]?.timeoutMs).toBeGreaterThan(0);
      expect(executor.options[1]?.timeoutMs).toBeLessThanOrEqual(VERIFICATION_TIMEOUT_MS);
      expect(result.records[0]?.outcome).toBe('findings');
      expect(result.records[0]?.verification).toMatchObject({ status: 'completed', requested: 1, accepted: 1 });
      expect(result.records[0]?.findings[0]?.verification.status).toBe('confirmed');
      expect(result.records[0]?.findings[0]?.verification.reason).not.toContain('test-key');
      expect(result.review.coverage.verification).toMatchObject({ status: 'completed', required: true });
      expect(result.review.verdict.status).toBe('blocked');
      const artifact = await readFile(join(fixture.output, 'reviews/verification/000001.json'), 'utf8');
      expect(artifact).toContain('"disposition": "confirmed"');
      expect(artifact).not.toContain('test-key');
      expect(artifact).toContain('[redacted]');
    } finally {
      await fixture.cleanup();
    }
  });

  it('records an explicit verifier falsification without turning a clean change inconclusive', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const candidate = reviewFinding({ evidence: 'new' });
      const finding = new FileReviewValidator(
        file, await readFile(join(fixture.review, file.diffFile), 'utf8'), 'defects',
      ).validateFinding(candidate);
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 3, fileId: file.id, outcome: 'findings', findings: [candidate] }) },
        { text: JSON.stringify({
          version: 1, fileId: file.id, results: [{
            candidateId: finding.id, disposition: 'rejected',
            reason: 'The changed line is covered by a guard.', citations: [],
          }],
        }) },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor, verifyCandidates: true });
      expect(result.records[0]).toMatchObject({
        outcome: 'clean', findings: [], verification: { status: 'completed', requested: 1, rejected: 1 },
      });
      expect(result.review.verdict.status).toBe('mergeable');
      expect(result.review.coverage.verificationRejections).toBe(1);
      expect(result.review.limitations).toContainEqual(expect.objectContaining({
        code: 'candidates-disproved', required: false,
      }));
    } finally {
      await fixture.cleanup();
    }
  });

  it('publishes only a confirmed sibling when another candidate stays inconclusive', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const first = reviewFinding({ evidence: 'new' });
      const second = reviewFinding({ evidence: 'new', title: 'A separate failure path needs an owner decision' });
      const validator = new FileReviewValidator(
        file, await readFile(join(fixture.review, file.diffFile), 'utf8'), 'defects',
      );
      const firstId = validator.validateFinding(first).id;
      const secondId = validator.validateFinding(second).id;
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 3, fileId: file.id, outcome: 'findings', findings: [first, second] }) },
        { text: JSON.stringify({
          version: 1, fileId: file.id, results: [
            { candidateId: firstId, disposition: 'confirmed', reason: 'Changed trigger proves the claim.',
              citations: [{ role: 'contract', revision: HEAD_SHA, path: 'src/example.ts',
                startLine: 1, endLine: 1, evidence: 'new' }] },
            { candidateId: secondId, disposition: 'inconclusive', reason: 'No independent source proves reachability.', citations: [] },
          ],
        }) },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor, verifyCandidates: true });
      expect(executor.prompts).toHaveLength(2);
      expect(result.records[0]).toMatchObject({
        outcome: 'findings', verification: { status: 'incomplete', requested: 2, accepted: 1, rejected: 1 },
      });
      expect(result.records[0]?.findings.map((finding) => finding.id)).toEqual([firstId]);
      expect(result.records[0]?.rejectedCandidates).toContainEqual(expect.objectContaining({
        stage: 'verification', code: 'verification-inconclusive',
      }));
      expect(result.review.coverage.verification).toMatchObject({ status: 'incomplete', required: true });
      expect(result.review.verdict.status).toBe('blocked');
    } finally {
      await fixture.cleanup();
    }
  });

  it('retains an evidence-backed human question for a deterministic owner decision', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const candidate = reviewFinding({ evidence: 'new' });
      const finding = new FileReviewValidator(
        file, await readFile(join(fixture.review, file.diffFile), 'utf8'), 'defects',
      ).validateFinding(candidate);
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 3, fileId: file.id, outcome: 'findings', findings: [candidate] }) },
        { text: JSON.stringify({
          version: 1, fileId: file.id, results: [{
            candidateId: finding.id, disposition: 'human-question', classification: 'question',
            reason: 'Owner must decide whether the documented behavior is intentional.',
            citations: [{ role: 'contract', revision: HEAD_SHA, path: 'src/example.ts',
              startLine: 1, endLine: 1, evidence: 'new' }],
          }],
        }) },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor, verifyCandidates: true });
      expect(result.records[0]?.findings[0]).toMatchObject({ classification: 'question', verification: { status: 'confirmed' } });
      expect(result.review.verdict.status).toBe('human-decision-required');
    } finally {
      await fixture.cleanup();
    }
  });

  it('suppresses every candidate when the verifier returns invalid output', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({
          version: 3, fileId: '000001', outcome: 'findings', findings: [reviewFinding({ evidence: 'new' })],
        }) },
        { text: '{"version":1,"fileId":"000001","results":[]}' },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor, verifyCandidates: true });
      expect(result.exitCode).toBe(1);
      expect(result.records[0]).toMatchObject({
        outcome: 'omitted', errorKind: 'verification-failed', findings: [],
        verification: { status: 'incomplete', requested: 1, accepted: 0 },
      });
      expect(result.review.findings).toEqual([]);
      expect(result.review.verdict.status).toBe('inconclusive');
      expect(result.review.limitations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'candidate-verification-incomplete', required: true }),
      ]));
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['timed-out', 'failed'] as const)('fails closed on a %s verifier invocation', async (status) => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({
          version: 3, fileId: '000001', outcome: 'findings', findings: [reviewFinding({ evidence: 'new' })],
        }) },
        { status, durationMs: 3_000, diagnostic: 'test-key unavailable' },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor, verifyCandidates: true });
      expect(result.records[0]).toMatchObject({
        outcome: 'omitted', errorKind: 'verification-failed', findings: [],
        durationMs: 3_001,
        verification: { status: 'incomplete', requested: 1, accepted: 0, durationMs: 3_000 },
      });
      expect(result.review.coverage.verification).toMatchObject({ status: 'incomplete', required: true });
      expect(result.review.findings).toEqual([]);
      expect(result.records[0]?.reason).not.toContain('test-key');
      expect(await readFile(join(fixture.output, 'reviews/verification/000001.json'), 'utf8'))
        .not.toContain('test-key');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a verifier citation whose path is not an already validated source location', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const file = bundle.manifest.files[0]!;
      const candidate = reviewFinding({ evidence: 'new' });
      const finding = new FileReviewValidator(
        file, await readFile(join(fixture.review, file.diffFile), 'utf8'), 'defects',
      ).validateFinding(candidate);
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 3, fileId: file.id, outcome: 'findings', findings: [candidate] }) },
        { text: JSON.stringify({
          version: 1, fileId: file.id, results: [{
            candidateId: finding.id, disposition: 'confirmed', reason: 'Graph relationship is sufficient.',
            citations: [{
              role: 'contract', revision: HEAD_SHA, path: 'src/other.ts',
              startLine: 1, endLine: 1, evidence: 'new',
            }],
          }],
        }) },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor, verifyCandidates: true });
      expect(result.records[0]).toMatchObject({
        outcome: 'omitted', errorKind: 'verification-failed', findings: [],
        verification: { status: 'incomplete' },
      });
      expect(result.review.verdict.status).toBe('inconclusive');
      expect(result.review.findings).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports progress after each completed file', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 2, fileId: '000001', outcome: 'clean', findings: [] }) },
      ]);
      const progress: string[] = [];
      const validated: unknown[] = [];
      const result = await runFileReviews({
        environment: environment.review!,
        executor,
        onFileValidated: (event) => validated.push(event),
        onFileDone: (record) => progress.push(`${record.path}: ${record.outcome}`),
      });

      expect(result.exitCode).toBe(0);
      expect(progress).toEqual(['src/example.ts: clean']);
      expect(validated).toEqual([{
        fileId: '000001',
        path: 'src/example.ts',
        outcome: 'clean',
        durationMs: 1,
        findingCount: 0,
        rejectedCandidateCount: 0,
      }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs one prompt per reviewed file and writes records and summary', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        {
          text: reviewDocument({ version: 2, fileId: '000001', outcome: 'clean', findings: [] }),
        },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });

      expect(result.exitCode).toBe(0);
      expect(executor.prompts).toHaveLength(1);
      // The prompt is self-contained: system policy + untrusted user context.
      expect(executor.prompts[0]!.system).toContain('# Review policy');
      expect(executor.prompts[0]!.user).toContain('"fileId":"000001"');

      const record = JSON.parse(
        await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
      ) as { version: number; outcome: string; rawModelOutput?: string };
      expect(record.version).toBe(4);
      expect(record.outcome).toBe('clean');
      expect(record.rawModelOutput).toBeDefined();
      await expect(readFile(join(fixture.output, 'reviews', '000001.md'), 'utf8')).resolves.toContain(
        '# Review: src/example.ts',
      );

      const summary = JSON.parse(
        await readFile(join(fixture.output, 'reviews', 'summary.json'), 'utf8'),
      ) as { reviewedFiles: number; findings: number; files: Array<{ outcome: string }> };
      expect(summary.reviewedFiles).toBe(1);
      expect(summary.findings).toBe(0);
      expect(summary.files[0]?.outcome).toBe('clean');

      const review = JSON.parse(
        await readFile(join(fixture.output, 'reviews', 'review.json'), 'utf8'),
      ) as { version: number; verdict: { status: string }; coverage: { files: { status: string } } };
      expect(review).toMatchObject({
        version: 2,
        verdict: { status: 'mergeable' },
        coverage: { files: { status: 'completed' } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('adds source-validated indexed context to the prompt and review artifacts', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src', 'related.ts'), 'export const related = true;\nsecond line\n');
      const contextPath = await writeCodeContext(fixture);
      const environment = parseReviewEnvironment({
        ...cleanReviewEnvironment(fixture, 'echo'),
        REDLINE_CODE_CONTEXT: contextPath,
        REDLINE_CODE_CONTEXT_REPOSITORY: 'owner/repository',
      });
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 2, fileId: '000001', outcome: 'clean', findings: [] }) },
      ]);

      const result = await runFileReviews({ environment: environment.review!, executor });

      expect(result.exitCode).toBe(0);
      expect(executor.prompts[0]!.user).toContain('"contextVersion":4');
      expect(executor.prompts[0]!.user).toContain('"indexedContext"');
      expect(executor.prompts[0]!.user).toContain('export const related = true;\\nsecond line');
      expect(result.summary.codeContext).toMatchObject({
        status: 'complete',
        filesWithContext: 1,
        relatedSpans: 1,
        cache: 'built',
        timings: { installationMs: 1, restoreMs: 2, validationMs: 3, indexMs: 4, queryMs: 5 },
      });
      expect(result.records[0]!.codeContext).toMatchObject({ status: 'complete', relatedSpans: 1 });
      const markdown = await readFile(join(fixture.output, 'reviews', 'summary.md'), 'utf8');
      expect(markdown).toContain('**Indexed context:** complete; 1 files, 1 spans');
      expect(markdown).toContain('**Index cache:** built');
      expect(markdown).toContain('validate 3 ms, index 4 ms, query 5 ms');
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps the file-only prompt when configured context is invalid', async () => {
    const fixture = await createBundleFixture();
    try {
      const baselineEnvironment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const baselineExecutor = new ScriptedExecutor();
      baselineExecutor.script([
        { text: reviewDocument({ version: 2, fileId: '000001', outcome: 'clean', findings: [] }) },
      ]);
      await runFileReviews({ environment: baselineEnvironment.review!, executor: baselineExecutor });

      const contextPath = await writeCodeContext(fixture, { invalid: true });
      const environment = parseReviewEnvironment({
        ...cleanReviewEnvironment(fixture, 'echo'),
        REDLINE_CODE_CONTEXT: contextPath,
        REDLINE_CODE_CONTEXT_REPOSITORY: 'owner/repository',
      });
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 2, fileId: '000001', outcome: 'clean', findings: [] }) },
      ]);

      const result = await runFileReviews({ environment: environment.review!, executor });

      expect(result.exitCode).toBe(0);
      expect(executor.prompts[0]).toEqual(baselineExecutor.prompts[0]);
      expect(executor.prompts[0]!.user).toContain('"contextVersion":3');
      expect(executor.prompts[0]!.user).not.toContain('"indexedContext"');
      expect(result.summary.codeContext).toMatchObject({ status: 'unavailable', reason: 'artifact-invalid' });
      expect(result.records[0]!.codeContext).toMatchObject({ status: 'unavailable', reason: 'artifact-invalid' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('validates findings, renders their spans, and derives suggestions and fix prompts', async () => {
    const fixture = await createBundleFixture({
      diff: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new line\n',
      headContent: 'new line\n',
    });
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        {
          text: reviewDocument({
            version: 3,
            fileId: '000001',
            outcome: 'findings',
            findings: [reviewFinding({
              title: 'Missing guard returns the wrong result',
              severity: 'high',
              startLine: 1,
              endLine: 1,
              evidence: 'new line',
              behavioralContract: 'The guard must reject the unsupported input.',
              failureScenario: 'The unsupported input reaches the changed line.',
              reachability: 'The public entry point calls this function.',
              rootCause: 'The changed line bypasses the guard.',
              impact: 'Wrong result.',
              blastRadius: 'All callers passing the unsupported input.',
              fix: 'Restore the check.',
              regressionTest: 'Exercise the unsupported input before and after the fix.',
              suggestedChange: 'guarded line',
              remediationStatus: 'proposed',
            })],
          }),
        },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(result.exitCode).toBe(0);
      expect(result.summary.findings).toBe(1);
      expect(result.summary.files[0]?.outcome).toBe('findings');
      expect(result.summary.files[0]?.findingSpans).toEqual(['1']);

      const record = JSON.parse(
        await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
      ) as {
        outcome: string;
        findings: Array<{
          id: string;
          startLine: number;
          endLine: number;
          suggestion?: string;
          fixPrompt: string;
          suggestedChange?: unknown;
        }>;
      };
      expect(record.outcome).toBe('findings');
      const finding = record.findings[0]!;
      expect(finding.id).toMatch(/^f-[0-9a-f]{24}$/u);
      expect(finding.startLine).toBe(1);
      expect(finding.endLine).toBe(1);
      expect(finding.suggestion).toBe('-new line\n+guarded line');
      expect(finding.fixPrompt).toContain('Fix one code-review finding.');
      expect(finding.fixPrompt).toContain('Location: src/example.ts:1 (side RIGHT: the new version of the file)');
      expect(finding.fixPrompt).toContain('  1 | new line');
      expect(finding.suggestedChange).toBeUndefined();

      const markdown = await readFile(join(fixture.output, 'reviews', '000001.md'), 'utf8');
      expect(markdown).toContain('- **Location:** src/example.ts:1 (side RIGHT)');
      expect(markdown).toContain('-new line');
      expect(markdown).toContain('+guarded line');
      const summaryMarkdown = await readFile(join(fixture.output, 'reviews', 'summary.md'), 'utf8');
      expect(summaryMarkdown).toContain('| src/example.ts | findings | executed | 1 (1) | disabled (0 spans) |');
    } finally {
      await fixture.cleanup();
    }
  });

  it('publishes a valid sibling while recording an independently rejected candidate', async () => {
    const fixture = await createBundleFixture({
      diff: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new line\n',
      headContent: 'new line\n',
    });
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      const candidate = {
        category: 'correctness',
        classification: 'defect',
        severity: 'high',
        confidence: 0.9,
        side: 'RIGHT',
        startLine: 1,
        endLine: 1,
        evidence: 'new line',
        impact: 'Wrong result.',
        fix: 'Restore the check.',
      };
      executor.script([{ text: reviewDocument({
        version: 2,
        fileId: '000001',
        outcome: 'findings',
        findings: [candidate, { ...candidate, evidence: 'invented line' }],
      }) }]);

      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(result.exitCode).toBe(0);
      expect(result.records[0]?.outcome).toBe('findings');
      expect(result.records[0]?.findings).toHaveLength(1);
      expect(result.records[0]?.rejectedCandidates).toHaveLength(1);
      expect(result.review.rejectedCandidates).toHaveLength(1);
      expect(result.review.coverage.specialists[0]?.status).toBe('incomplete');
      expect(result.review.verdict.status).toBe('blocked');
    } finally {
      await fixture.cleanup();
    }
  });

  it('records invalid model output as an omitted file and keeps running', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { text: 'definitely not json' },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });
      // Every reviewed file failed validation: the run fails loudly.
      expect(result.exitCode).toBe(1);
      expect(result.summary.omittedFiles).toBe(1);
      expect(result.summary.files[0]?.errorKind).toBe('invalid-output');
    } finally {
      await fixture.cleanup();
    }
  });

  it('records harness failures as omitted files with bounded reasons', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { status: 'failed', diagnostic: 'boom'.repeat(200) },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(result.exitCode).toBe(1);
      const record = JSON.parse(
        await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
      ) as { outcome: string; errorKind?: string; reason?: string };
      expect(record.outcome).toBe('omitted');
      expect(record.errorKind).toBe('harness-failed');
      expect((record.reason ?? '').length).toBeLessThanOrEqual(501);
    } finally {
      await fixture.cleanup();
    }
  });

  it('persists a bounded Pi no-text diagnostic without model or stderr content', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      const diagnostic = JSON.stringify({
        schema: 'pi-no-text/v1',
        class: 'missing-text-parts',
        cause: 'provider-output',
        exit: 0,
        durationMs: 10,
        startupMs: 1,
        firstTextMs: null,
        stdout: [12, 12, false],
        stderr: [20, 20, false],
        malformed: 0,
        events: ['message_end', 'turn_end', 'agent_end'],
        parts: ['thinking'],
        stop: 'stop',
        outputTokens: 8,
      });
      executor.script([{ status: 'failed', diagnostic }]);

      await runFileReviews({ environment: environment.review!, executor });
      const record = JSON.parse(
        await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
      ) as { reason?: string };

      expect(record.reason).toBe(diagnostic);
      expect(record.reason).not.toMatch(/prompt|source text|raw output|reasoning|credential|stderr content/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports files excluded by trusted eligibility without treating them as required omissions', async () => {
    const fixture = await createBundleFixture({ reviewed: false, exclusionReason: 'generated raw benchmark capture' });
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(executor.prompts).toHaveLength(0);
      expect(result.summary.reviewedFiles).toBe(0);
      expect(result.summary.omittedFiles).toBe(0);
      expect(result.summary.excludedFiles).toEqual([{
        fileId: '000001', path: 'src/example.ts', reason: 'generated raw benchmark capture',
      }]);
      expect(result.review.coverage.files).toMatchObject({
        status: 'completed',
        considered: [],
        omitted: [],
        excluded: ['src/example.ts'],
        excludedDetails: [{ fileId: '000001', path: 'src/example.ts', reason: 'generated raw benchmark capture' }],
      });
      expect(result.exitCode).toBe(0);
      const summaryFiles = await readFile(join(fixture.output, 'reviews', 'summary.md'), 'utf8');
      expect(summaryFiles).toContain('`src/example.ts` — generated raw benchmark capture');
    } finally {
      await fixture.cleanup();
    }
  });

  it('records binary files as omitted without prompting the harness', async () => {
    const fixture = await createBundleFixture({
      manifestOverrides: { binary: true, baseFile: null },
    });
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(executor.prompts).toHaveLength(0);
      expect(result.summary.omittedFiles).toBe(1);
      const record = JSON.parse(
        await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
      ) as { outcome: string; reason?: string };
      expect(record.reason).toMatch(/binary/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('end-to-end with the real echo harness via the registry', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const result = await runFileReviews({ environment: environment.review! });
      expect(result.exitCode).toBe(0);
      expect(result.summary.harness).toBe('echo');
      expect(result.summary.reviewedFiles).toBe(1);
      expect(result.summary.findings).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('records a preparation failure as omitted without aborting the run', async () => {
    const fixture = await createBundleFixture();
    try {
      // A second manifest entry whose diff carries a malformed hunk header;
      // prompt preparation must fail for this file only.
      const manifestPath = join(fixture.review, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        files: Array<Record<string, unknown>>;
      };
      manifest.files.push({
        id: '000002',
        status: 'A',
        oldPath: null,
        newPath: 'src/broken.ts',
        similarity: null,
        additions: 1,
        deletions: 0,
        binary: false,
        reviewed: true,
        exclusionReason: null,
        diffFile: 'diffs/000002.diff',
        baseFile: null,
      });
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(
        join(fixture.review, 'diffs', '000002.diff'),
        '--- a/src/broken.ts\n+++ b/src/broken.ts\n@@ -1 +1 @@\n@@ malformed hunk header\n',
      );
      await writeFile(join(fixture.source, 'src', 'broken.ts'), 'broken\n');

      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 2, fileId: '000001', outcome: 'clean', findings: [] }) },
        { text: reviewDocument({ version: 2, fileId: '000002', outcome: 'clean', findings: [] }) },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });

      // The healthy file is still reviewed; the broken one never reaches the
      // harness.
      expect(result.exitCode).toBe(0);
      expect(executor.prompts).toHaveLength(1);
      expect(result.summary.omittedFiles).toBe(1);

      const broken = JSON.parse(await readFile(join(fixture.output, 'reviews', '000002.json'), 'utf8')) as {
        outcome: string;
        errorKind?: string;
        reason?: string;
      };
      expect(broken.outcome).toBe('omitted');
      expect(broken.errorKind).toBe('preparation-failed');
      expect(broken.reason).toMatch(/malformed hunk header/u);

      const good = JSON.parse(await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8')) as {
        outcome: string;
      };
      expect(good.outcome).toBe('clean');
    } finally {
      await fixture.cleanup();
    }
  });

  it('redacts the selected credential from persisted diagnostics and output', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      // A harness failure whose diagnostic echoes the credential.
      executor.script([
        { status: 'failed', diagnostic: 'connect failed for key test-key at openrouter' },
      ]);
      await runFileReviews({ environment: environment.review!, executor });
      const record = JSON.parse(await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8')) as {
        reason?: string;
      };
      expect(record.reason).toBeDefined();
      expect(record.reason).not.toContain('test-key');
      expect(record.reason).toContain('[redacted]');
    } finally {
      await fixture.cleanup();
    }
  });

  it('redacts the selected credential from persisted raw model output', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      // Output that fails parsing (not JSON) and echoes the credential.
      executor.script([{ text: 'leaked test-key in text' }]);
      await runFileReviews({ environment: environment.review!, executor });
      const record = JSON.parse(await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8')) as {
        rawModelOutput?: string;
      };
      expect(record.rawModelOutput).toBeDefined();
      expect(record.rawModelOutput).not.toContain('test-key');
      expect(record.rawModelOutput).toContain('[redacted]');
    } finally {
      await fixture.cleanup();
    }
  });

  it('redacts the selected credential from persisted candidate rejection reasons', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([{ text: reviewDocument({
        version: 2,
        fileId: '000001',
        outcome: 'findings',
        findings: [{
          category: 'correctness',
          classification: 'defect',
          severity: 'high',
          confidence: 0.9,
          side: 'RIGHT',
          startLine: 1,
          endLine: 1,
          evidence: 'new',
          impact: 'Wrong result.',
          fix: 'Restore the check.',
          'test-key': true,
        }],
      }) }]);
      await runFileReviews({ environment: environment.review!, executor });
      const record = JSON.parse(await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8')) as {
        rejectedCandidates: Array<{ reason: string }>;
      };
      expect(record.rejectedCandidates).toHaveLength(1);
      expect(record.rejectedCandidates[0]?.reason).not.toContain('test-key');
      expect(record.rejectedCandidates[0]?.reason).toContain('[redacted]');
    } finally {
      await fixture.cleanup();
    }
  });

  it('reuses an unchanged validated file across a later head without a model call', async () => {
    const fixture = await createBundleFixture();
    try {
      const firstEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{
        text: reviewDocument({
          version: 4,
          fileId: '000001',
          outcome: 'clean',
          findings: [],
          contextRequests: [],
        }),
        durationMs: 321,
      }]);
      const first = await runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor });
      expect(first.summary.reuse).toMatchObject({ reusedFiles: 0, executedFiles: 1, savedDurationMs: 0 });
      const [cacheEntry] = await readdir(join(fixture.root, 'review-reuse', 'entries'));
      const cacheText = await readFile(join(fixture.root, 'review-reuse', 'entries', cacheEntry as string), 'utf8');
      expect(cacheText).not.toContain('rawModelOutput');
      expect(cacheText).not.toContain('REDLINE_UNTRUSTED_FILE_CONTEXT');
      expect(cacheText).not.toContain('test-key');

      const nextHead = 'c'.repeat(40);
      const manifest = JSON.parse(await readFile(join(fixture.review, 'manifest.json'), 'utf8')) as {
        version: 1;
        base: string;
        head: string;
        files: unknown[];
      };
      await writeFile(join(fixture.review, 'manifest.json'), JSON.stringify({ ...manifest, head: nextHead }));
      await writeFile(join(fixture.review, 'revisions.txt'), `base=${BASE_SHA}\nhead=${nextHead}\n`);

      const secondEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const secondExecutor = new ScriptedExecutor();
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });

      expect(secondExecutor.prompts).toHaveLength(0);
      expect(second.records[0]).toMatchObject({ outcome: 'clean', execution: 'reused', durationMs: 0, savedDurationMs: 321 });
      expect(second.summary.head).toBe(nextHead);
      expect(second.review.head).toBe(nextHead);
      expect(second.summary.reuse).toMatchObject({
        status: 'enabled',
        restoredEntries: 1,
        reusedFiles: 1,
        executedFiles: 0,
        savedDurationMs: 321,
      });
      const recordMarkdown = await readFile(join(fixture.output, 'reviews', '000001.md'), 'utf8');
      const summaryMarkdown = await readFile(join(fixture.output, 'reviews', 'summary.md'), 'utf8');
      expect(recordMarkdown).toContain('**Execution:** reused');
      expect(recordMarkdown).toContain('**Estimated model time saved:** 321 ms');
      expect(summaryMarkdown).toContain('**Review reuse:** enabled; 1 reused, 0 executed, 321 ms estimated saved');
    } finally {
      await fixture.cleanup();
    }
  });

  it('reuses findings only after remapping and revalidating current source evidence', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src/related.ts'), 'stable contract\n');
      const candidate = reviewFinding({
        evidence: 'new',
        suggestedChange: 'fixed',
        remediationStatus: 'proposed',
        supportingEvidence: [{
          role: 'contract',
          revision: HEAD_SHA,
          path: 'src/related.ts',
          startLine: 1,
          endLine: 1,
          evidence: 'stable contract',
        }],
      });
      const firstEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{
        text: reviewDocument({
          version: 4,
          fileId: '000001',
          outcome: 'findings',
          findings: [candidate],
          contextRequests: [],
        }),
        durationMs: 444,
      }]);
      const first = await runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor });
      const firstFindingId = first.records[0]?.findings[0]?.id;
      const firstSuggestion = first.records[0]?.findings[0]?.suggestion;
      expect(firstSuggestion).toBe('-new\n+fixed');

      const nextHead = 'c'.repeat(40);
      const manifest = JSON.parse(await readFile(join(fixture.review, 'manifest.json'), 'utf8')) as {
        version: 1;
        base: string;
        head: string;
        files: unknown[];
      };
      await writeFile(join(fixture.review, 'manifest.json'), JSON.stringify({ ...manifest, head: nextHead }));
      await writeFile(join(fixture.review, 'revisions.txt'), `base=${BASE_SHA}\nhead=${nextHead}\n`);

      const secondEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const secondExecutor = new ScriptedExecutor();
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });
      const restoredFinding = second.records[0]?.findings[0];

      expect(secondExecutor.prompts).toHaveLength(0);
      expect(second.records[0]).toMatchObject({ outcome: 'findings', execution: 'reused', savedDurationMs: 444 });
      expect(restoredFinding?.supportingEvidence[0]?.revision).toBe(nextHead);
      expect(restoredFinding?.id).not.toBe(firstFindingId);
      expect(restoredFinding?.suggestion).toBe(firstSuggestion);
      expect(restoredFinding?.remediationStatus).toBe('proposed');
      expect(restoredFinding?.fixPrompt).toContain('src/example.ts:1');
    } finally {
      await fixture.cleanup();
    }
  });

  it('restores cached rejected-candidate reasons that include the truncation ellipsis', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const executor = new ScriptedExecutor();
      executor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const first = await runFileReviews({ environment: environment.review!, executor });
      const record = first.records[0];
      expect(record).toBeDefined();

      const fingerprint = `sha256:${'a'.repeat(64)}`;
      const reason = `${'x'.repeat(MAX_REVIEW_REASON_CHARS)}…`;
      const cache = await loadReviewReuseCache(environment.review!.reuse!);
      await cache.write(
        'src/example.ts',
        fingerprint,
        BASE_SHA,
        HEAD_SHA,
        {
          ...record!,
          rejectedCandidates: [{ index: 0, stage: 'verification', code: 'bounded-reason', reason }],
        },
        10,
        false,
      );

      const restored = await loadReviewReuseCache(environment.review!.reuse!);
      expect(restored.stats).toEqual({ restoredEntries: 1, invalidEntries: 0 });
      expect(restored.match('src/example.ts', fingerprint)?.result.rejectedCandidates[0]?.reason).toBe(reason);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reuses verifier-mode clean records only when verification is complete or not applicable', async () => {
    const fixture = await createBundleFixture();
    try {
      const firstEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const first = await runFileReviews({
        environment: firstEnvironment.review!,
        executor: firstExecutor,
        verifyCandidates: true,
      });
      expect(first.records[0]?.verification?.status).toBe('not-applicable');

      const secondEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const secondExecutor = new ScriptedExecutor();
      const second = await runFileReviews({
        environment: secondEnvironment.review!,
        executor: secondExecutor,
        verifyCandidates: true,
      });

      expect(secondExecutor.prompts).toHaveLength(0);
      expect(second.records[0]).toMatchObject({ execution: 'reused', outcome: 'clean' });
      expect(second.records[0]?.verification?.status).toBe('not-applicable');
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps completed per-file cache entries when a later worker aborts the run', async () => {
    const fixture = await createMultiFileFixture([10, 20]);
    try {
      const firstEnvironment = parseReviewEnvironment({
        ...reuseReviewEnvironment(fixture),
        REDLINE_REVIEW_CONCURRENCY: '1',
      });
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      await expect(runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor })).rejects.toThrow(
        /scripted executor ran out/u,
      );

      const secondEnvironment = parseReviewEnvironment({
        ...reuseReviewEnvironment(fixture),
        REDLINE_REVIEW_CONCURRENCY: '1',
      });
      const secondExecutor = new ScriptedExecutor();
      secondExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000002', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });

      expect(secondExecutor.prompts).toHaveLength(1);
      expect(second.records.map((record) => record.execution)).toEqual(['reused', 'executed']);
      expect(second.summary.reuse).toMatchObject({ reusedFiles: 1, executedFiles: 1 });
    } finally {
      await fixture.cleanup();
    }
  });

  it('never reuses an omitted harness result', async () => {
    const fixture = await createBundleFixture();
    try {
      const firstEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{ status: 'failed', diagnostic: 'provider failed', durationMs: 10 }]);
      const first = await runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor });
      expect(first.records[0]?.outcome).toBe('omitted');

      const secondEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const secondExecutor = new ScriptedExecutor();
      secondExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });

      expect(secondExecutor.prompts).toHaveLength(1);
      expect(second.records[0]?.execution).toBe('executed');
      expect(second.summary.reuse?.restoredEntries).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('executes a file again when its authoritative diff changes', async () => {
    const fixture = await createBundleFixture();
    try {
      const firstEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      await runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor });

      await writeFile(
        join(fixture.review, 'diffs/000001.diff'),
        'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+changed\n',
      );
      await writeFile(join(fixture.source, 'src/example.ts'), 'changed\n');
      const secondEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const secondExecutor = new ScriptedExecutor();
      secondExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });

      expect(secondExecutor.prompts).toHaveLength(1);
      expect(second.records[0]?.execution).toBe('executed');
      expect(second.summary.reuse?.reusedFiles).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('executes a file again when trusted review configuration changes', async () => {
    const fixture = await createBundleFixture();
    try {
      const firstEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      await runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor });

      const secondEnvironment = parseReviewEnvironment({
        ...reuseReviewEnvironment(fixture),
        REDLINE_TIMEOUT: '31m',
      });
      const secondExecutor = new ScriptedExecutor();
      secondExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });

      expect(secondExecutor.prompts).toHaveLength(1);
      expect(second.records[0]?.execution).toBe('executed');
    } finally {
      await fixture.cleanup();
    }
  });

  it('executes a file again when pull request requirements change', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.review, 'requirements.md'), 'Preserve behavior A.\n');
      const firstEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      await runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor });

      await writeFile(join(fixture.review, 'requirements.md'), 'Preserve behavior B.\n');
      const secondEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const secondExecutor = new ScriptedExecutor();
      secondExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });

      expect(secondExecutor.prompts).toHaveLength(1);
      expect(second.records[0]?.execution).toBe('executed');
    } finally {
      await fixture.cleanup();
    }
  });

  it('executes a file again when its resolved indexed context changes', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src/related.ts'), 'related one\nrelated two\n');
      const contextPath = await writeCodeContext(fixture);
      const environmentValues = {
        ...reuseReviewEnvironment(fixture),
        REDLINE_CODE_CONTEXT: contextPath,
        REDLINE_CODE_CONTEXT_REPOSITORY: 'owner/repository',
      };
      const firstEnvironment = parseReviewEnvironment(environmentValues);
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      await runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor });

      await writeFile(join(fixture.source, 'src/related.ts'), 'changed one\nchanged two\n');
      const secondEnvironment = parseReviewEnvironment(environmentValues);
      const secondExecutor = new ScriptedExecutor();
      secondExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });

      expect(secondExecutor.prompts).toHaveLength(1);
      expect(second.records[0]?.execution).toBe('executed');
      expect(second.summary.reuse?.reusedFiles).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('revalidates cached supporting evidence and executes when current source disagrees', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src/related.ts'), 'stable contract\n');
      const candidate = reviewFinding({
        evidence: 'new',
        supportingEvidence: [{
          role: 'contract',
          revision: HEAD_SHA,
          path: 'src/related.ts',
          startLine: 1,
          endLine: 1,
          evidence: 'stable contract',
        }],
      });
      const firstEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{ text: reviewDocument({
        version: 4,
        fileId: '000001',
        outcome: 'findings',
        findings: [candidate],
        contextRequests: [],
      }) }]);
      await runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor });

      await writeFile(join(fixture.source, 'src/related.ts'), 'changed contract\n');
      const secondEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const secondExecutor = new ScriptedExecutor();
      secondExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });

      expect(secondExecutor.prompts).toHaveLength(1);
      expect(second.records[0]?.outcome).toBe('clean');
      expect(second.records[0]?.execution).toBe('executed');
      expect(second.summary.reuse?.invalidEntries).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores a corrupt restored entry and performs a normal review', async () => {
    const fixture = await createBundleFixture();
    try {
      const firstEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const firstExecutor = new ScriptedExecutor();
      firstExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      await runFileReviews({ environment: firstEnvironment.review!, executor: firstExecutor });
      const entriesDirectory = join(fixture.root, 'review-reuse', 'entries');
      const [entry] = await readdir(entriesDirectory);
      const entryPath = join(entriesDirectory, entry as string);
      const cached = JSON.parse(await readFile(entryPath, 'utf8')) as {
        result: { executionDurationMs: number };
      };
      cached.result.executionDurationMs += 1;
      await writeFile(entryPath, JSON.stringify(cached));

      const secondEnvironment = parseReviewEnvironment(reuseReviewEnvironment(fixture));
      const secondExecutor = new ScriptedExecutor();
      secondExecutor.script([{ text: reviewDocument({
        version: 4, fileId: '000001', outcome: 'clean', findings: [], contextRequests: [],
      }) }]);
      const second = await runFileReviews({ environment: secondEnvironment.review!, executor: secondExecutor });

      expect(secondExecutor.prompts).toHaveLength(1);
      expect(second.summary.reuse).toMatchObject({ invalidEntries: 1, reusedFiles: 0, executedFiles: 1 });
    } finally {
      await fixture.cleanup();
    }
  });

  it('redacts the selected credential from derived suggestions and fix prompts', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      // A finding whose model-proposed replacement echoes the credential.
      executor.script([
        {
          text: reviewDocument({
            version: 2,
            fileId: '000001',
            outcome: 'findings',
            findings: [
              {
                category: 'correctness',
                classification: 'defect',
                severity: 'high',
                confidence: 0.9,
                side: 'RIGHT',
                startLine: 1,
                endLine: 1,
                evidence: 'new',
                impact: 'Wrong result.',
                fix: 'Restore the check with test-key.',
                suggestedChange: 'guarded using test-key',
              },
            ],
          }),
        },
      ]);
      await runFileReviews({ environment: environment.review!, executor });
      const record = JSON.parse(await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8')) as {
        findings: Array<{ suggestion?: string; fixPrompt: string }>;
      };
      const finding = record.findings[0]!;
      expect(finding.suggestion).toBeDefined();
      expect(finding.suggestion).not.toContain('test-key');
      expect(finding.suggestion).toContain('[redacted]');
      expect(finding.fixPrompt).not.toContain('test-key');
      expect(finding.fixPrompt).toContain('[redacted]');
    } finally {
      await fixture.cleanup();
    }
  });
});
