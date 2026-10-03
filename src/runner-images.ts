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
  // Published by CI "CI » Publish runner images" from main 05e5906
  // (PR #70 merge). Index digests verified via the registry manifest header.
  pi: 'ghcr.io/dragoscirjan/redline-pi-runner@sha256:b5be3e089d62e0c3cb0bed74ee57ab8f8e1f2598d68aee771a19c236b1acdaa5',
  opencode:
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:68921649c13dfc3f5f174a4d4e09e86db4680d857e69af8329605c8d9ee28792',
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
