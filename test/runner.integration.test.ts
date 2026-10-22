import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReviewEnvironment } from '../src/review/environment.js';
import { runFileReviews } from '../src/review/runner.js';
import type { HarnessExecuteOptions, HarnessExecutor, HarnessPrompt, HarnessRun, PreparedHarness } from '../src/harness-executor/types.js';
import { loadReviewBundle } from '../src/review/bundle.js';
import { FileReviewValidator } from '../src/review/report.js';
import { VERIFICATION_TIMEOUT_MS } from '../src/review/runner.js';
import {
  cleanReviewEnvironment,
  createBundleFixture,
  BASE_SHA,
  HEAD_SHA,
  type BundleFixture,
} from './helpers/bundle.js';
import { reviewFinding } from './helpers/finding.js';

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

async function writeCodeContext(fixture: BundleFixture, value?: object): Promise<string> {
  const path = join(fixture.root, 'code-context.json');
  await writeFile(path, JSON.stringify(value ?? {
    version: 1,
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
    timings: { installationMs: 1, restoreMs: 2, indexMs: 3, queryMs: 4, saveMs: null },
  }));
  return path;
}

describe('runFileReviews', () => {
  it('passes only action-resolved source and counts duplicate requests once', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src/related.ts'), 'export const related = true;\n');
      const contextPath = await writeCodeContext(fixture, {
        version: 1, provider: { id: 'cgc', version: '0.5.7' },
        repository: 'owner/repository', revision: HEAD_SHA, status: 'complete',
        files: [{ changedPath: 'src/example.ts', status: 'complete', related: [{
          path: 'src/related.ts', startLine: 1, endLine: 1, reason: 'incoming CALLS',
        }] }],
        diagnostics: [], timings: { installationMs: 0, restoreMs: 0, indexMs: 0, queryMs: 0, saveMs: null },
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
        followUp: { status: 'completed', requested: 1, completed: 1, durationMs: 5 },
        verification: { status: 'completed' }, outcome: 'findings',
      });
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
      expect(executor.options[1]?.timeoutMs).toBe(VERIFICATION_TIMEOUT_MS);
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
      const result = await runFileReviews({
        environment: environment.review!,
        executor,
        onFileDone: (record) => progress.push(`${record.path}: ${record.outcome}`),
      });

      expect(result.exitCode).toBe(0);
      expect(progress).toEqual(['src/example.ts: clean']);
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
      expect(executor.prompts[0]!.user).toContain('"contextVersion":2');
      expect(executor.prompts[0]!.user).toContain('"indexedContext"');
      expect(executor.prompts[0]!.user).toContain('export const related = true;\\nsecond line');
      expect(result.summary.codeContext).toMatchObject({
        status: 'complete',
        filesWithContext: 1,
        relatedSpans: 1,
      });
      expect(result.records[0]!.codeContext).toMatchObject({ status: 'complete', relatedSpans: 1 });
      const markdown = await readFile(join(fixture.output, 'reviews', 'summary.md'), 'utf8');
      expect(markdown).toContain('**Indexed context:** complete; 1 files, 1 spans');
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
      expect(executor.prompts[0]!.user).toContain('"contextVersion":1');
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
      expect(summaryMarkdown).toContain('| src/example.ts | findings | 1 (1) | disabled (0 spans) |');
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

  it('skips files the bundle marks as not reviewed', async () => {
    const fixture = await createBundleFixture({ reviewed: false });
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(executor.prompts).toHaveLength(0);
      expect(result.summary.reviewedFiles).toBe(0);
      expect(result.exitCode).toBe(0);
      const summaryFiles = await readFile(join(fixture.output, 'reviews', 'summary.json'), 'utf8');
      expect(summaryFiles).toContain('"reviewedFiles": 0');
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
