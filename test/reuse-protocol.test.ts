import { describe, expect, it } from 'vitest';
import { buildReviewSemanticFingerprint } from '../src/review/reuse.ts';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { loadReviewCodeContext } from '../src/review/indexed-context.ts';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.ts';

describe('model-protocol reuse identity', () => {
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
