import { expect, it } from 'vitest';
import { parseOutputTokens, outputCaptureBytes } from '../src/harness-executor/output-budget.ts';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { loadReviewCodeContext } from '../src/review/indexed-context.ts';
import { buildReviewSemanticFingerprint } from '../src/review/reuse.ts';
import { FILE_REVIEW_DOCUMENT_VERSION } from '../src/review/report.ts';
import { runFileReviews } from '../src/review/runner.ts';
import { runBoundedProcess } from '../src/process-runner.ts';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.ts';

it('keeps generation tokens separate from deadlines and bounded stream capture', () => {
  expect(parseOutputTokens(undefined)).toBeUndefined();
  expect(parseOutputTokens('32768')).toBe(32768);
  expect(parseOutputTokens('262144')).toBe(262144);
  expect(outputCaptureBytes(undefined)).toBe(8 * 1024 * 1024);
  expect(outputCaptureBytes(16384)).toBe(8 * 1024 * 1024);
  expect(outputCaptureBytes(32768)).toBe(16 * 1024 * 1024);
  expect(outputCaptureBytes(262144)).toBe(64 * 1024 * 1024);
});

it.each(['', '0', '1023', '262145', '1e5', '3.5', '-1', ' 32768'])('rejects invalid environment token allowance %j', (value) => {
  expect(() => parseReviewEnvironment({ REDLINE_MAX_OUTPUT_TOKENS: value })).toThrow('max-output-tokens');
});

it('propagates the selected allowance to the executor and invalidates semantic review reuse', async () => {
  const fixture = await createBundleFixture();
  try {
    const environment = parseReviewEnvironment({ ...cleanReviewEnvironment(fixture, 'echo'), REDLINE_MAX_OUTPUT_TOKENS: '32768' }).review!;
    const bundle = await loadReviewBundle(environment.reviewDirectory, environment.sourceDirectory);
    const indexedContext = await loadReviewCodeContext(bundle, undefined);
    const options = { bundle, file: bundle.manifest.files[0]!, environment, indexedContext, verifyCandidates: false, followUpAvailable: false };
    const one = await buildReviewSemanticFingerprint(options);
    const two = await buildReviewSemanticFingerprint({ ...options, environment: { ...environment, maxOutputTokens: 65536 } });
    expect(one).not.toBe(two);
    let configured: number | undefined;
    const result = await runFileReviews({ environment, executor: {
      harness: 'echo',
      prepare: async (settings) => { configured = settings.maxOutputTokens; return { harness: 'echo', model: settings.model, description: 'scripted fixture' }; },
      execute: async () => ({ status: 'succeeded', harness: 'echo', exitCode: 0, text: JSON.stringify({ version: FILE_REVIEW_DOCUMENT_VERSION, fileId: '000001', outcome: 'clean', contextRequests: [], findings: [] }), diagnostic: '', durationMs: 0 }),
    } });
    expect(configured).toBe(32768); expect(result.summary.omittedFiles).toBe(0);
  } finally { await fixture.cleanup(); }
});

it('rejects an invalid capture allowance before spawning any process', async () => {
  let spawned = false;
  await expect(runBoundedProcess({ spawn: () => { spawned = true; throw new Error('must not spawn'); } }, {
    command: 'unused', args: [], timeoutMs: 1000, stdoutLimitBytes: 65 * 1024 * 1024,
  })).rejects.toThrow('stdout byte limit');
  expect(spawned).toBe(false);
});
