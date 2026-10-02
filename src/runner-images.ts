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
  // Published by CI "CI » Publish runner images" from main 178324ec
  // (PR #38 merge). Index digests verified via skopeo inspect and the
  // registry manifest header.
  pi: 'ghcr.io/dragoscirjan/redline-pi-runner@sha256:97b30304bc0fbe167d39debb5d41ff9397d982e5decc503754d264aa3bb73dd8',
  opencode:
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:bde5813b22f726ab8b653b518e15ba295cc3925340908b0ffc79e2deab162ca2',
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
