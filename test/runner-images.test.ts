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
    'ghcr.io/dragoscirjan/redline-pi-runner@sha256:4da023e2211a2926c70f51efcc1c7b4b0f8f4ebb919ed48b8edf1dc3fd8ab1b8',
  );
  assert.equal(
    resolveRunnerImage('opencode'),
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:c3df3f5db70638d04f3f67548ebed51407458204b8ef5a84ff7581ebe977411d',
  );
});

test('rejects unknown backends instead of guessing an image', () => {
  const message = thrownMessage(() => resolveRunnerImage('claude' as 'pi'));
  assert.match(message, /no runner image is pinned for the claude backend/u);
});
