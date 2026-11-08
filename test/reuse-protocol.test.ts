import { join } from 'node:path';
import type { HarnessExecutor } from '../src/harness-executor/types.ts';
import { runFileReviews } from '../src/review/runner.ts';
import { describe, expect, it } from 'vitest';
import { buildReviewSemanticFingerprint } from '../src/review/reuse.ts';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { loadReviewCodeContext } from '../src/review/indexed-context.ts';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.ts';

describe('model-protocol reuse identity', () => {
  it('restores only after prepared analysis identity is known and invalidates changed analysis state', async () => {
    const f = await createBundleFixture();
    try {
      const parsed = parseReviewEnvironment(cleanReviewEnvironment(f, 'pi')).review!;
      let identity = 'captured-analysis-a', executions = 0, preparations = 0;
      let failPreparation = false;
      const executor: HarnessExecutor = { harness: 'pi',
        /** Supply current analysis identity before cache lookup; unavailable identity must not authorize reuse. */
        async prepare(settings) {
        preparations++;
        if (failPreparation) throw new Error('synthetic preparation unavailable');
        return { harness: 'pi', model: settings.model, description: 'scripted isolated analysis', executionMode: 'isolated',
          analysis: { identity, manifestFile: '', command: process.execPath, launcher: '', statuses: [], backends: [] } };
      }, async execute() {
        executions++;
        return { harness: 'pi', status: 'succeeded', exitCode: 0, durationMs: 1, diagnostic: '',
          text: JSON.stringify({ version: 4, fileId: '000001', outcome: 'clean', reason: 'Synthetic validated result.', findings: [], contextRequests: [] }) };
      } };
      const review = (name: string) => runFileReviews({ executor, environment: { ...parsed, outputDirectory: join(f.output, name),
        reuse: { directory: join(f.output, 'cache'), namespace: 'sha256:' + 'a'.repeat(64) } } });
      expect((await review('first')).records[0]?.execution).toBe('executed');
      expect((await review('same')).records[0]?.execution).toBe('reused');
      expect(executions).toBe(1); expect(preparations).toBe(2);
      identity = 'captured-analysis-b';
      expect((await review('changed')).records[0]?.execution).toBe('executed');
      expect(executions).toBe(2);
      failPreparation = true;
      await expect(review('unknown')).rejects.toThrow('synthetic preparation unavailable');
      expect(executions).toBe(2);
    } finally { await f.cleanup(); }
  });
  it('keeps equal tool-aware inputs stable and invalidates changed tools or captured analysis bytes', async () => {
    const f = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(f.review, f.source);
      const indexedContext = await loadReviewCodeContext(bundle, undefined);
      const environment = parseReviewEnvironment(cleanReviewEnvironment(f, 'pi')).review!;
      const common = { bundle, file: bundle.manifest.files[0]!, indexedContext, environment, verifyCandidates: false, followUpAvailable: false };
      const none = await buildReviewSemanticFingerprint(common);
      const tool = 'mcp__redline_context_mode__ctx_index';
      const first = await buildReviewSemanticFingerprint({ ...common, tools: [tool], analysisIdentity: 'captured-bytes-a' });
      const next = await buildReviewSemanticFingerprint({ ...common, tools: [tool], analysisIdentity: 'captured-bytes-b' });
      expect(first).not.toBe(none); expect(next).not.toBe(first);
      expect(await buildReviewSemanticFingerprint(common)).toBe(none);
      expect(await buildReviewSemanticFingerprint({ ...common, tools: [tool], analysisIdentity: 'captured-bytes-a' })).toBe(first);
      expect(await buildReviewSemanticFingerprint({ ...common, tools: [tool], analysisIdentity: 'captured-bytes-b' })).toBe(next);
      expect(await buildReviewSemanticFingerprint({ ...common, tools: [], analysisIdentity: 'captured-bytes-a' })).not.toBe(first);
    } finally { await f.cleanup(); }
  });
  it('invalidates request protocol changes without including credentials or scheduling in the identity', async () => {
    const f = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(f.review, f.source);
      const indexedContext = await loadReviewCodeContext(bundle, undefined);
      const environment = parseReviewEnvironment(cleanReviewEnvironment(f, 'echo')).review!;
      const common = { bundle, file: bundle.manifest.files[0]!, indexedContext, verifyCandidates: false, followUpAvailable: false };
      const initial = await buildReviewSemanticFingerprint({ ...common, environment });
      const compatible = await buildReviewSemanticFingerprint({ ...common, environment: { ...environment, modelProtocol: 'compatible' } });
      const schema = await buildReviewSemanticFingerprint({ ...common, environment: { ...environment, modelProtocol: 'openrouter-json' } });
      const mixed = await buildReviewSemanticFingerprint({ ...common, environment: { ...environment, scheduling: 'mixed' } });
      const rotated = await buildReviewSemanticFingerprint({ ...common, environment: { ...environment,
        credential: { provider: environment.model.provider, value: 'ROTATED_FIXTURE_KEY' } } });
      expect(initial).toBe(compatible); expect(schema).not.toBe(initial); expect(mixed).toBe(initial);
      expect(rotated).toBe(initial); expect(rotated).not.toContain('ROTATED_FIXTURE_KEY');
    } finally { await f.cleanup(); }
  });
});
