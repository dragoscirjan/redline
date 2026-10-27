/** CI smoke: real Pi, fixed loopback endpoints, no paid provider or dev dependencies. */
import assert from 'node:assert/strict';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { runFileReviews } from '../src/review/runner.ts';
import { createBundleFixture, cleanReviewEnvironment } from './helpers/bundle.ts';
import { startErrorServer, startMockServer } from './helpers/model-server.ts';

const server = await startMockServer({ MOCK_EXPECT_REVIEW_PROTOCOL: '1', MOCK_EXPECT_MAX_OUTPUT_TOKENS: '32768', MOCK_EXPECT_AUTHORIZATION: 'credential-less' });
const fixture = await createBundleFixture();
try {
  const parsed = parseReviewEnvironment({ ...cleanReviewEnvironment(fixture, 'pi'),
    REDLINE_MODEL_CONFIG: JSON.stringify({ provider: 'openrouter', endpoint: `http://127.0.0.1:${server.port}/v1`, model: 'test-model', auth: 'none' }),
    REDLINE_MODEL_AUTH: undefined, REDLINE_TIMEOUT: '1m', REDLINE_MAX_OUTPUT_TOKENS: '32768' });
  const result = await runFileReviews({ environment: { ...parsed.review!, modelProtocol: 'openrouter-json' } });
  assert.equal(result.records[0]?.outcome, 'clean', result.records[0]?.reason);
  console.log('Pi HTTP request verified: reasoning disabled request, strict v4 schema, required parameters, no tools, 32768 output tokens.');
} finally {
  await server.stop(); await fixture.cleanup();
}

for (const [provider, protocol] of [['openrouter', 'openrouter-json'], ['openrouter', 'compatible'], ['mock', 'compatible']] as const) {
  for (const authenticated of [true, false]) {
    const sentinel = 'FIXTURE_BEARER_SENTINEL';
    const authServer = await startMockServer({
      MOCK_EXPECT_AUTHORIZATION: authenticated ? `Bearer ${sentinel}` : 'credential-less',
      ...(protocol === 'openrouter-json' ? { MOCK_EXPECT_REVIEW_PROTOCOL: '1' } : {}),
    });
    const authFixture = await createBundleFixture();
    try {
      const parsed = parseReviewEnvironment({ ...cleanReviewEnvironment(authFixture, 'pi'),
        REDLINE_MODEL_CONFIG: JSON.stringify({ provider, endpoint: `http://127.0.0.1:${authServer.port}/v1`, model: 'test-model',
          ...(authenticated ? {} : { auth: 'none' }) }),
        REDLINE_MODEL_AUTH: authenticated ? JSON.stringify({ [provider]: sentinel }) : undefined,
        REDLINE_TIMEOUT: '1m',
      });
      const result = await runFileReviews({ environment: { ...parsed.review!, modelProtocol: protocol } });
      assert.equal(result.records[0]?.outcome, 'clean', result.records[0]?.reason);
      assert.ok(!JSON.stringify(result).includes(sentinel));
      console.log(`Pi auth verified: ${provider}/${protocol}, ${authenticated ? 'selected bearer credential' : 'no real credential'}.`);
    } finally { await authServer.stop(); await authFixture.cleanup(); }
  }
}

for (const [status, message] of [[400, 'Invalid JSON schema for response_format'], [401, 'Invalid API key'], [503, 'Provider temporarily unavailable']] as const) {
  const sentinel = 'FIXTURE_NOT_A_REAL_KEY';
  const errorServer = await startErrorServer(status, `${message}; ${sentinel}`);
  const failedFixture = await createBundleFixture();
  try {
    const parsed = parseReviewEnvironment({ ...cleanReviewEnvironment(failedFixture, 'pi'),
      REDLINE_MODEL_CONFIG: JSON.stringify({ provider: 'openrouter', endpoint: `http://127.0.0.1:${errorServer.port}/v1`, model: 'test-model', auth: 'none' }),
      REDLINE_MODEL_AUTH: undefined, REDLINE_TIMEOUT: '1m' });
    const result = await runFileReviews({ environment: { ...parsed.review!, modelProtocol: 'openrouter-json',
      credential: { provider: 'openrouter', value: sentinel } } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.records[0]?.errorKind, 'harness-failed');
    const diagnostic = JSON.parse(result.records[0]!.reason!);
    assert.equal(diagnostic.schema, 'pi-error/v1'); assert.equal(diagnostic.status, status);
    assert.equal(diagnostic.scope, status === 503 ? 'file' : 'run'); assert.equal(diagnostic.retryable, status === 503);
    assert.ok(diagnostic.message.includes(message)); assert.ok(diagnostic.message.includes('[redacted]'));
    assert.ok(!JSON.stringify(result).includes(sentinel));
    assert.equal(errorServer.requests(), status === 503 ? 2 : 1, 'only explicit transient errors get one retry');
    console.log(`Pi HTTP ${status} verified: useful redacted error, ${diagnostic.scope} scope, ${errorServer.requests()} request(s).`);
  } finally { await errorServer.stop(); await failedFixture.cleanup(); }
}
