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
  // Published by CI "CI » Publish runner images" from main be233d6b
  // (PR #42 merge). Index digests verified via skopeo inspect and the
  // registry manifest header.
  pi: 'ghcr.io/dragoscirjan/redline-pi-runner@sha256:4da023e2211a2926c70f51efcc1c7b4b0f8f4ebb919ed48b8edf1dc3fd8ab1b8',
  opencode:
    'ghcr.io/dragoscirjan/redline-opencode-runner@sha256:c3df3f5db70638d04f3f67548ebed51407458204b8ef5a84ff7581ebe977411d',
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
