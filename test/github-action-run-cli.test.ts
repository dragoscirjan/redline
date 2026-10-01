import assert from 'node:assert/strict';
import test from 'node:test';
import { parseActionEnvironment, type ActionEnvironment } from '../src/github-action-run-cli.js';

const MODEL_CONFIG = JSON.stringify({
  provider: 'openrouter',
  endpoint: 'https://openrouter.ai/api/v1',
  model: 'provider/model-name',
});
const RUNNER_IMAGE = 'ghcr.io/dragoscirjan/redline-pi@sha256:' + 'a'.repeat(64);

function validEnvironment(overrides: Partial<ActionEnvironment> = {}): ActionEnvironment {
  return {
    githubToken: 'token-sentinel',
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
    reviewDirectory: '/tmp/review',
    sourceDirectory: '/tmp/source-at-head',
    journalPath: '/tmp/redline-journal/journal.jsonl',
    runId: '1234567890',
    repository: 'dragoscirjan/redline',
    pullRequest: '7',
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    ...overrides,
  };
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

test('parses the full action environment into a frozen run configuration', () => {
  const parsed = parseActionEnvironment(validEnvironment());
  assert.equal(parsed.parsed.configuration.backend, 'pi');
  assert.deepEqual(parsed.identity, {
    runId: '1234567890',
    repository: 'dragoscirjan/redline',
    pullRequest: 7,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    reportStyle: 'single-block',
  });
  assert.equal(parsed.reviewDirectory, '/tmp/review');
  assert.equal(parsed.journalPath, '/tmp/redline-journal/journal.jsonl');
  assert.equal(parsed.parsed.timeout.milliseconds, 1_800_000);
  assert.equal(Object.isFrozen(parsed.parsed), true);
});

test('normalizes upper-case revisions to the lowercase full object ids', () => {
  const parsed = parseActionEnvironment(validEnvironment({ base: 'A'.repeat(40), head: 'B'.repeat(40) }));
  assert.equal(parsed.identity.base, 'a'.repeat(40));
  assert.equal(parsed.identity.head, 'b'.repeat(40));
});

test('rejects a missing GitHub token', () => {
  assert.match(thrownMessage(() => parseActionEnvironment(validEnvironment({ githubToken: '' }))), /GH_TOKEN is required/u);
});

test('rejects missing or invalid action inputs with named variables', () => {
  const missing = { ...validEnvironment(), backend: undefined } as unknown as ActionEnvironment;
  assert.match(thrownMessage(() => parseActionEnvironment(missing)), /REDLINE_BACKEND is required/u);
  assert.match(
    thrownMessage(() => parseActionEnvironment(validEnvironment({ pullRequest: 'not-a-number' }))),
    /pull request number must be a positive integer/u,
  );
  assert.match(
    thrownMessage(() => parseActionEnvironment(validEnvironment({ timeout: '1d' }))),
    /exceeds the 360-minute cap/u,
  );
});

test('rejects NUL bytes in environment values', () => {
  assert.throws(() => parseActionEnvironment(validEnvironment({ repository: 'owner/repo\u0000suffix' })));
});
