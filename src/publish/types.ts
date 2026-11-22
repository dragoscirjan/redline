import type { Effect } from 'effect';

/** Native target/auth/position/receipt schemas remain deferred; do not normalize away forge differences. */
export type PublicationScope = unknown;
export type PublicationAuthorization = unknown;
export type FileReviewPublication = unknown;
export type ManagedObjectId = unknown;
export type PublicationReceipt = unknown;

/** Forge transport boundary; shared policy and artifact provenance live in PublicationService. */
export interface ReviewPublisher {
  currentHead(scope: PublicationScope): Effect.Effect<string | undefined, Error>;
  publishFileReview(scope: PublicationScope, review: FileReviewPublication): Effect.Effect<ManagedObjectId, Error>;
  upsertSummary(scope: PublicationScope, body: string, marker: string): Effect.Effect<ManagedObjectId, Error>;
}
