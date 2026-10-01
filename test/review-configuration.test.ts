import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseFirstRunnableReviewConfiguration,
  selectDirectModelCredential,
  type FirstRunnableReviewConfigurationInput,
} from '../src/review-configuration.js';

const DEFAULT_MODEL_CONFIG = JSON.stringify({
  provider: 'openrouter',
  endpoint: 'https://openrouter.ai/api/v1',
  model: 'provider/model-name',
});

function parse(
  overrides: Partial<FirstRunnableReviewConfigurationInput> = {},
): ReturnType<typeof parseFirstRunnableReviewConfiguration> {
  return parseFirstRunnableReviewConfiguration({
    backend: 'pi',
    modelConfig: DEFAULT_MODEL_CONFIG,
    credentialIsolation: 'direct',
    ...overrides,
  });
}

function thrownMessage(callback: () => unknown): string {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  return caught.message;
}

test('parses the same first runnable profile for Pi and OpenCode', () => {
  for (const backend of ['pi', 'opencode']) {
    const configuration = parse({ backend });
    assert.equal(configuration.backend, backend);
    assert.deepEqual(configuration.model, {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      model: 'provider/model-name',
    });
    assert.equal(configuration.credentialIsolation, 'direct');
    assert.equal(configuration.findingScope, 'defects');
    assert.equal(configuration.reportStyle, 'single-block');
  }
});

test('allows inline reporting and both finding scopes but rejects unsupported choices', () => {
  assert.equal(parse({ reportStyle: 'inline' }).reportStyle, 'inline');
  assert.equal(parse({ findingScope: 'defects-and-risks' }).findingScope, 'defects-and-risks');
  assert.throws(() => parse({ backend: 'other' }), /backend is unsupported/u);
  assert.throws(() => parse({ reportStyle: 'thread' }), /report style is unsupported/u);
  assert.throws(() => parse({ findingScope: 'everything' }), /finding scope is unsupported/u);
});

test('requires an explicit direct credential-isolation choice', () => {
  assert.throws(
    () => parse({ credentialIsolation: undefined }),
    /must be explicitly set to direct/u,
  );
  for (const value of ['', 'gateway', 'none']) {
    assert.throws(
      () => parse({ credentialIsolation: value }),
      /must be explicitly set to direct/u,
    );
  }
});

test('accepts bounded public, private, and loopback HTTP endpoints', () => {
  for (const endpoint of [
    'https://models.example.test/v1',
    'http://10.0.0.20:8080/v1',
    'http://127.0.0.1:1234/v1?api-version=1',
  ]) {
    const configuration = parse({
      modelConfig: JSON.stringify({ provider: 'private-model', endpoint, model: 'model:latest' }),
    });
    assert.equal(configuration.model.endpoint, endpoint);
  }
});

test('rejects malformed, incomplete, and extensible model configuration', () => {
  for (const modelConfig of [
    '{',
    'null',
    '[]',
    JSON.stringify({ endpoint: 'https://example.test/v1', model: 'model' }),
    JSON.stringify({
      provider: 'provider',
      endpoint: 'https://example.test/v1',
      model: 'model',
      headers: { Authorization: 'secret' },
    }),
    JSON.stringify({ provider: 'bad provider', endpoint: 'https://example.test/v1', model: 'model' }),
    JSON.stringify({ provider: 'provider', endpoint: 'https://example.test/v1', model: '' }),
    JSON.stringify({ provider: 'provider', endpoint: 'https://example.test/v1', model: 'model\u0085name' }),
  ]) {
    assert.throws(() => parse({ modelConfig }));
  }
  assert.throws(
    () => parse({ modelConfig: JSON.stringify({ padding: 'x'.repeat(16 * 1024) }) }),
    /byte limit/u,
  );
});

test('rejects non-network and ambiguous endpoint URLs', () => {
  for (const endpoint of [
    '/v1',
    'file:///tmp/model',
    'ssh://models.example.test/v1',
    'https://user:secret@models.example.test/v1',
    'https://models.example.test/v1#fragment',
    'https://models.example.test/v1\u0000suffix',
  ]) {
    assert.throws(
      () => parse({
        modelConfig: JSON.stringify({ provider: 'provider', endpoint, model: 'model' }),
      }),
    );
  }
});

test('selects only the configured provider credential', () => {
  const unused = 'unused-credential-sentinel';
  const selected = selectDirectModelCredential(
    parse(),
    JSON.stringify({ openrouter: 'selected-secret', other: unused }),
  );
  assert.deepEqual(selected, { provider: 'openrouter', value: 'selected-secret' });
  assert.doesNotMatch(JSON.stringify(selected), new RegExp(unused, 'u'));
  assert.deepEqual(Object.keys(selected).sort(), ['provider', 'value']);
});

test('rejects missing, empty, non-string, and oversized selected credentials', () => {
  const configuration = parse();
  for (const modelCredentials of [
    '{}',
    JSON.stringify({ openrouter: '' }),
    JSON.stringify({ openrouter: '   ' }),
    JSON.stringify({ openrouter: { value: 'secret' } }),
    JSON.stringify({ openrouter: 'line\nbreak' }),
    JSON.stringify({ openrouter: 'secret\u0085suffix' }),
    JSON.stringify({ openrouter: 'x'.repeat(16 * 1024 + 1) }),
  ]) {
    assert.throws(() => selectDirectModelCredential(configuration, modelCredentials));
  }
});

test('bounds and validates the credential map without exposing its values', () => {
  const configuration = parse();
  const sentinel = 'credential-value-must-not-appear';
  for (const modelCredentials of [
    '{',
    'null',
    '[]',
    JSON.stringify({ other: sentinel }),
    JSON.stringify({ openrouter: `${sentinel}\n` }),
    JSON.stringify({ padding: 'x'.repeat(64 * 1024) }),
  ]) {
    const message = thrownMessage(() => selectDirectModelCredential(configuration, modelCredentials));
    assert.doesNotMatch(message, new RegExp(sentinel, 'u'));
    assert.doesNotMatch(message, /model-credentials.*\{/u);
  }
});
