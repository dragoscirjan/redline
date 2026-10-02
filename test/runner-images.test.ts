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
    'ghcr.io/dragoscirjan/redline-pi-runner@sha256:97b30304bc0fbe167d39debb5d41ff9397d982e5decc503754d264aa3bb73dd8',
  );
  assert.equal(
    resolveRunnerImage('opencode'),
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:bde5813b22f726ab8b653b518e15ba295cc3925340908b0ffc79e2deab162ca2',
  );
});

test('rejects unknown backends instead of guessing an image', () => {
  const message = thrownMessage(() => resolveRunnerImage('claude' as 'pi'));
  assert.match(message, /no runner image is pinned for the claude backend/u);
});
