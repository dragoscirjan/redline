import type { ReviewBackend } from './backend-process.js';
import { validateDigestPinnedImage } from './container-staging.js';

/**
 * Fixed backend-to-digest runner image table.
 *
 * The action stages the review container from the entry selected for the
 * configured backend. Callers never choose the image. Digests are the
 * multi-platform manifest digests published by trusted main workflows,
 * including owner-approved candidate source builds. Updates land only through
 * reviewed pull requests. Tag and `latest` references are rejected, so the
 * table cannot drift into a mutable reference.
 */

export interface RunnerImageTable {
  readonly [backend: string]: string;
}

export const RUNNER_IMAGES: Readonly<RunnerImageTable> = Object.freeze({
  // Candidate run 37219185669, approved source 62067e8b4204ab03cd118451a199631a954308ca.
  // Verified AMD64/ARM64 index descriptors, source bootstrap hashes and versions.
  pi: 'ghcr.io/dragoscirjan/redline-pi-runner@sha256:eb16ec08c3b96b81f105d386f9dcea44bc6f9c61a00647947b61abc8aaef7a3e',
  opencode:
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:5b94a4cf739f79e9d9bd5a612e38e6cc733b0dc0584264b876de9b4b371c8a7d',
});

export function resolveRunnerImage(backend: ReviewBackend): string {
  const image = RUNNER_IMAGES[backend];
  if (typeof image !== 'string' || image.length === 0) {
    throw new Error(`no runner image is pinned for the ${backend} backend`);
  }
  // Validate at resolution time too, so a malformed table edit fails closed
  // instead of reaching the container engine.
  validateDigestPinnedImage(image);
  return image;
}
