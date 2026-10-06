/**
 * Forge-neutral publication contracts.
 *
 * A publisher adapts the generic publication surface to one forge (GitHub
 * today; Forgejo and Gitea are future adapters behind this interface). The
 * review core never learns forge specifics. Every managed object carries a
 * machine-readable hidden marker, and ownership is always checked as marker
 * plus expected author before anything is updated or duplicated.
 */

export interface ReviewScope {
  /** Repository in `owner/name` syntax. */
  readonly repository: string;
  readonly pullRequest: number;
  /** The reviewed head commit; publications bind to it and to no other. */
  readonly head: string;
}

export interface InlineReviewComment {
  /** Repository path of the changed file, exactly as in the manifest. */
  readonly path: string;
  /** `LEFT` for removed lines, `RIGHT` for added lines — GitHub's semantics. */
  readonly side: 'LEFT' | 'RIGHT';
  readonly line: number;
  readonly body: string;
}

/** One file's review, published as one forge review with inline comments. */
export interface FileReviewPublication {
  readonly fileId: string;
  readonly path: string;
  /** Review body; must end with `marker`. */
  readonly body: string;
  readonly marker: string;
  readonly comments: readonly InlineReviewComment[];
}

export interface ReviewPublisher {
  /** The pull request's current head; compared against `scope.head` as the stale guard. */
  currentHead(scope: ReviewScope): Promise<string>;
  /** Upserts the actor-owned managed summary comment carrying `marker`. */
  upsertSummary(scope: ReviewScope, body: string, marker: string): Promise<number>;
  /** Publishes one file review; idempotent per scope, marker, and author. */
  publishFileReview(scope: ReviewScope, publication: FileReviewPublication): Promise<number>;
}
