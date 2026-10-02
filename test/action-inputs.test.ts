import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  DEFAULT_TIMEOUT_INPUT,
  parseCompositeActionInputs,
  parseContextOnlyInputs,
  reviewMode,
} from '../src/action-inputs.js';

const MODEL_CONFIG = JSON.stringify({
  provider: 'openrouter',
  endpoint: 'https://openrouter.ai/api/v1',
  model: 'provider/model-name',
});
const RUNNER_IMAGE = 'ghcr.io/dragoscirjan/redline-pi@sha256:' + 'a'.repeat(64);

function validInputs(overrides: Partial<Parameters<typeof parseCompositeActionInputs>[0]> = {}) {
  return {
    backend: 'pi',
    modelConfig: MODEL_CONFIG,
    modelAuth: JSON.stringify({ openrouter: 'selected-secret' }),
    findingScope: '',
    reportStyle: '',
    timeout: '',
    credentialIsolation: 'direct',
    runnerImage: RUNNER_IMAGE,
    containerEngine: 'podman',
    artifactName: 'redline-review-1',
    artifactRetentionDays: '',
    ...overrides,
  };
}

test('rejects unknown action inputs at runtime', () => {
  const extended = validInputs() as Record<string, string>;
  extended.reviewInstructions = 'untrusted-value';
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(extended as Parameters<typeof parseCompositeActionInputs>[0])),
    /unknown action input: reviewInstructions/u,
  );
});

test('detects the review mode from the input selection', () => {
  assert.equal(reviewMode(validInputs() as Record<string, unknown> & Parameters<typeof reviewMode>[0]), 'review');
  const contextOnly = validInputs({ backend: '', modelConfig: '', modelAuth: '', runnerImage: '' }) as Record<string, unknown> &
    Parameters<typeof reviewMode>[0];
  assert.equal(reviewMode(contextOnly), 'context-only');
  const partial = validInputs({ modelAuth: '' }) as Record<string, unknown> & Parameters<typeof reviewMode>[0];
  assert.match(
    thrownMessage(() => reviewMode(partial)),
    /requires backend, model-config, model-auth, and runner-image together/u,
  );
});

test('validates standalone inputs in context-only mode', () => {
  const contextOnly = validInputs({
    backend: '',
    modelConfig: '',
    modelAuth: '',
    runnerImage: '',
    timeout: '2h',
    artifactRetentionDays: '10',
  });
  const parsed = parseContextOnlyInputs(contextOnly as Record<string, unknown> & Parameters<typeof parseContextOnlyInputs>[0]);
  assert.equal(parsed.timeout.minutes, 120);
  assert.equal(parsed.artifactRetentionDays, 10);
  assert.throws(() =>
    parseContextOnlyInputs(
      validInputs({ backend: '', modelConfig: '', modelAuth: '', runnerImage: '', findingScope: 'everything' }) as Record<
        string,
        unknown
      > & Parameters<typeof parseContextOnlyInputs>[0],
    ),
  );
});

test('requires an explicit credential-isolation choice in review mode', () => {
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ credentialIsolation: '' }))),
    /must be explicitly set to direct/u,
  );
});

function contextOnlyInputs(overrides: Partial<Parameters<typeof parseContextOnlyInputs>[0]> = {}) {
  return {
    backend: '',
    modelConfig: '',
    modelAuth: '',
    findingScope: '',
    reportStyle: '',
    timeout: '',
    credentialIsolation: '',
    runnerImage: '',
    containerEngine: 'podman',
    artifactName: 'redline-review-1',
    artifactRetentionDays: '',
    ...overrides,
  } as Record<string, unknown> & Parameters<typeof parseContextOnlyInputs>[0];
}

test('rejects partial review selections', () => {
  assert.throws(() => parseCompositeActionInputs(validInputs({ modelAuth: '' })));
  assert.throws(() => parseCompositeActionInputs(validInputs({ runnerImage: '' })));
  assert.equal(reviewMode(contextOnlyInputs()), 'context-only');
});

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

test('parses the documented defaults', () => {
  const parsed = parseCompositeActionInputs(validInputs());
  assert.equal(parsed.timeout.minutes, Number(DEFAULT_TIMEOUT_INPUT.replace('m', '')));
  assert.equal(parsed.artifactRetentionDays, DEFAULT_ARTIFACT_RETENTION_DAYS);
  assert.equal(parsed.containerEngine, 'podman');
  assert.deepEqual(parsed.configuration.findingScope, 'defects');
  assert.deepEqual(parsed.configuration.reportStyle, 'single-block');
  assert.deepEqual(parsed.credential, { provider: 'openrouter', value: 'selected-secret' });
  assert.equal(parsed.runnerImage, RUNNER_IMAGE);
});

test('parses duration and enum overrides', () => {
  const parsed = parseCompositeActionInputs(
    validInputs({ timeout: '1h30m', findingScope: 'defects-and-risks', reportStyle: 'inline', containerEngine: 'docker' }),
  );
  assert.equal(parsed.timeout.minutes, 90);
  assert.deepEqual(parsed.configuration.findingScope, 'defects-and-risks');
  assert.deepEqual(parsed.configuration.reportStyle, 'inline');
  assert.equal(parsed.containerEngine, 'docker');
});

test('rejects unsupported enum values', () => {
  assert.match(thrownMessage(() => parseCompositeActionInputs(validInputs({ backend: 'claude' }))), /backend is unsupported/u);
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ findingScope: 'everything' }))),
    /finding scope is unsupported/u,
  );
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ reportStyle: 'thread' }))),
    /report style is unsupported/u,
  );
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ credentialIsolation: 'gateway' }))),
    /credential-isolation must be explicitly set to direct/u,
  );
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ containerEngine: 'nerdctl' }))),
    /container engine is unsupported/u,
  );
});

test('rejects malformed timeouts and bound violations', () => {
  assert.match(thrownMessage(() => parseCompositeActionInputs(validInputs({ timeout: '1d' }))), /exceeds the 360-minute cap/u);
  assert.match(thrownMessage(() => parseCompositeActionInputs(validInputs({ timeout: 'fast' }))), /not a valid duration/u);
});

test('rejects missing model-auth and unknown credential providers', () => {
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ modelAuth: '' }))),
    /requires backend, model-config, model-auth, and runner-image together/u,
  );
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ modelAuth: '{}' }))),
    /model-auth has no entry for the configured provider/u,
  );
});

test('rejects non-digest-pinned runner images', () => {
  for (const runnerImage of [
    'ghcr.io/dragoscirjan/redline-pi:latest',
    'ghcr.io/dragoscirjan/redline-pi',
    'ghcr.io/dragoscirjan/redline-pi@sha256:' + 'g'.repeat(64),
    'ghcr.io/dragoscirjan/redline-pi@sha256:' + 'a'.repeat(64) + ':latest',
  ]) {
    assert.throws(() => parseCompositeActionInputs(validInputs({ runnerImage })));
  }
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ runnerImage: '' }))),
    /requires backend, model-config, model-auth, and runner-image together/u,
  );
});

test('rejects invalid artifact names and retention bounds', () => {
  assert.throws(() => parseCompositeActionInputs(validInputs({ artifactName: '' })));
  assert.throws(() => parseCompositeActionInputs(validInputs({ artifactName: 'bad name with spaces' })));
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ artifactRetentionDays: '0' }))),
    /between 1 and 90/u,
  );
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ artifactRetentionDays: '91' }))),
    /between 1 and 90/u,
  );
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ artifactRetentionDays: 'ten' }))),
    /non-negative integer/u,
  );
});

test('rejects malformed model-config through the shared validation', () => {
  assert.throws(() => parseCompositeActionInputs(validInputs({ modelConfig: '{' })));
  assert.throws(() => parseCompositeActionInputs(validInputs({ modelConfig: 'null' })));
  assert.match(
    thrownMessage(() => parseCompositeActionInputs(validInputs({ modelConfig: '{}' }))),
    /missing a required field/u,
  );
});
