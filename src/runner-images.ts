import type { ReviewBackend } from './backend-process.js';
import { validateDigestPinnedImage } from './container-staging.js';

/**
 * Fixed backend-to-digest runner image table.
 *
 * The action stages the review container from the entry selected for the
 * configured backend. Callers never choose the image. Digests are the
 * multi-platform manifest digests that `.github/workflows/ci.release.yml`
 * pushes to GHCR from `main`; updates land only through reviewed pull
 * requests. Tag and `latest` references are rejected by validation, so the
 * table cannot drift into a mutable reference.
 */

export interface RunnerImageTable {
  readonly [backend: string]: string;
}

export const RUNNER_IMAGES: Readonly<RunnerImageTable> = Object.freeze({
  // Published by CI "CI » Publish runner images" from main 58a4aa8
  // (PR #62 merge). Index digests verified via the registry manifest header.
  pi: 'ghcr.io/dragoscirjan/redline-pi-runner@sha256:53dfc9e5409707097191da1bbd8fc03200b15f5bab349af5a440bed033eb2eca',
  opencode:
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:821956a7e5c5e745e16e76efc9546c1bc78dda59fb9fec84bc28b97a1f3e19f8',
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
