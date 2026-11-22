import type { ReviewRequest } from '../application/review.ts';

/** Capture writes to an explicitly selected directory; it never selects a model or publishes. */
export type CaptureRequest = Pick<ReviewRequest, 'repository' | 'base' | 'target'> & {
  readonly outputDirectory: string;
};

export interface CaptureCoverage {
  readonly excludedUntrackedFiles: number;
  readonly omittedSourceFiles: number;
  readonly inertSymlinks: number;
  readonly inertSubmodules: number;
}

export interface CapturedContextSnapshot {
  readonly repository: string;
  readonly base: string;
  readonly head: string;
}

export interface CapturedRevision {
  readonly reviewDirectory: string;
  readonly sourceDirectory: string;
  /** Excluded from dependency discovery; never executed by an analysis integration. */
  readonly repositoryDirectory?: string;
  readonly coverage?: CaptureCoverage;
  readonly contextSnapshot?: CapturedContextSnapshot;
  dispose(): Promise<void>;
}

export interface RevisionSource {
  capture(signal: AbortSignal): Promise<CapturedRevision>;
}
