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
    'ghcr.io/dragoscirjan/redline-pi-runner@sha256:b5be3e089d62e0c3cb0bed74ee57ab8f8e1f2598d68aee771a19c236b1acdaa5',
  );
  assert.equal(
    resolveRunnerImage('opencode'),
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:68921649c13dfc3f5f174a4d4e09e86db4680d857e69af8329605c8d9ee28792',
  );
});

test('rejects unknown backends instead of guessing an image', () => {
  const message = thrownMessage(() => resolveRunnerImage('claude' as 'pi'));
  assert.match(message, /no runner image is pinned for the claude backend/u);
});
