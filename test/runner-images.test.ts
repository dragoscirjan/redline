import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRunnerImage, RUNNER_IMAGES } from '../src/runner-images.js';

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

test('exposes a pinned image for every supported backend', () => {
  assert.deepEqual(Object.keys(RUNNER_IMAGES).sort(), ['opencode', 'pi']);
  for (const backend of ['pi', 'opencode'] as const) {
    const image = resolveRunnerImage(backend);
    assert.match(image, /^ghcr\.io\/dragoscirjan\/redline-(pi|opencode)-runner@sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(image, /:latest/u);
  }
});

test('resolves stable digest references', () => {
  assert.equal(
    resolveRunnerImage('pi'),
    'ghcr.io/dragoscirjan/redline-pi-runner@sha256:9d0abe6b6e32324766031e4c472e0bcc17c0776f399704dd5273a1320c003555',
  );
  assert.equal(
    resolveRunnerImage('opencode'),
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:420c52a5e1ae2f8b906cd227b8f6937b86b6dfb72ccf83780c17d90e89832fc7',
  );
});

test('rejects unknown backends instead of guessing an image', () => {
  const message = thrownMessage(() => resolveRunnerImage('claude' as 'pi'));
  assert.match(message, /no runner image is pinned for the claude backend/u);
});
