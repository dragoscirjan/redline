import { Context, Effect, Layer } from 'effect';

/** Select committed revisions or a working-tree snapshot without changing the repository. */
export type ReviewTarget =
  | { readonly kind: 'revision'; readonly head: string; readonly comparison: 'merge-base' | 'direct' }
  | { readonly kind: 'worktree'; readonly mode: 'staged' | 'unstaged' | 'all'; readonly untracked: boolean };

/** Model bindings, credentials and tool permissions belong to trusted service configuration. */
export interface ReviewRequest {
  readonly repository: string;
  readonly base: string;
  readonly target: ReviewTarget;
  readonly outputDirectory?: string;
}

/** Return run state and artifact location; callers own presentation and exit-code mapping. */
export interface ReviewResult {
  readonly status: 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'deadline-exhausted';
  readonly outputDirectory?: string;
}

/** Coordinate one bounded review for CLI, Docker and RPC callers. */
export class ReviewApplication extends Context.Service<ReviewApplication, {
  readonly review: (request: ReviewRequest) => Effect.Effect<ReviewResult, Error>;
}>()('@dragoscirjan/redline/application/ReviewApplication') {
  static readonly layer = Layer.succeed(ReviewApplication, {
    review: (_request: ReviewRequest): Effect.Effect<ReviewResult, Error> => {
      // Capture the change, warm up model/tools, review files, validate and write artifacts.
      // Keep lifecycle and budgets shared across stages; publication remains separate.
      return Effect.fail(new Error('Not implemented: ReviewApplication.review'));
    },
  });
}
