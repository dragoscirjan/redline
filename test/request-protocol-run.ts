/** CI smoke: real Pi, fixed loopback endpoint, no paid provider or dev dependencies. */
import assert from 'node:assert/strict';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { runFileReviews } from '../src/review/runner.ts';
import { createBundleFixture, cleanReviewEnvironment } from './helpers/bundle.ts';
import { startMockServer } from './helpers/model-server.ts';

const server = await startMockServer({ MOCK_EXPECT_REVIEW_PROTOCOL: '1', MOCK_EXPECT_MAX_OUTPUT_TOKENS: '32768' });
const fixture = await createBundleFixture();
try {
  const parsed = parseReviewEnvironment({ ...cleanReviewEnvironment(fixture, 'pi'),
    REDLINE_MODEL_CONFIG: JSON.stringify({ provider: 'openrouter', endpoint: `http://127.0.0.1:${server.port}/v1`, model: 'test-model', auth: 'none' }),
    REDLINE_MODEL_AUTH: undefined, REDLINE_TIMEOUT: '1m', REDLINE_MAX_OUTPUT_TOKENS: '32768' });
  const result = await runFileReviews({ environment: { ...parsed.review!, modelProtocol: 'openrouter-json' } });
  assert.equal(result.records[0]?.outcome, 'clean', result.records[0]?.errorKind);
  console.log('Pi HTTP request verified: reasoning disabled request, strict v4 schema, required parameters, no tools, 32768 output tokens.');
} finally {
  await server.stop(); await fixture.cleanup();
}
