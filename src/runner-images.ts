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
  // Published by CI "CI » Publish runner images" from main ca15f2d
  // (PR #67 merge). Index digests verified via the registry manifest header.
  pi: 'ghcr.io/dragoscirjan/redline-pi-runner@sha256:9d0abe6b6e32324766031e4c472e0bcc17c0776f399704dd5273a1320c003555',
  opencode:
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:420c52a5e1ae2f8b906cd227b8f6937b86b6dfb72ccf83780c17d90e89832fc7',
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
