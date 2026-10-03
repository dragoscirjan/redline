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
    'ghcr.io/dragoscirjan/redline-pi-runner@sha256:2d92c32981d01e584d3b30b3b9a304b520aa5d2acec006e35a04730048be652e',
  );
  assert.equal(
    resolveRunnerImage('opencode'),
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:13d0694533453f22981d757718edb6c724fb3acef5eb6044d6a904e6cb674155',
  );
});

test('rejects unknown backends instead of guessing an image', () => {
  const message = thrownMessage(() => resolveRunnerImage('claude' as 'pi'));
  assert.match(message, /no runner image is pinned for the claude backend/u);
});
