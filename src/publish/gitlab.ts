import { Effect } from 'effect';
import type { FileReviewPublication, ManagedObjectId, PublicationScope, ReviewPublisher } from './types.ts';

export class GitLabPublisher implements ReviewPublisher {
  currentHead(scope: PublicationScope): Effect.Effect<string | undefined, Error> {
    // Resolve GitLab.com or an explicitly supported self-managed target and immutable merge-request head.
    return Effect.fail(new Error('Not implemented: GitLabPublisher.currentHead'));
  }

  publishFileReview(scope: PublicationScope, review: FileReviewPublication): Effect.Effect<ManagedObjectId, Error> {
    // Map authoritative spans to native GitLab discussion positions and preserve partial failures.
    return Effect.fail(new Error('Not implemented: GitLabPublisher.publishFileReview'));
  }

  upsertSummary(scope: PublicationScope, body: string, marker: string): Effect.Effect<ManagedObjectId, Error> {
    // Upsert only the expected actor's managed summary note.
    return Effect.fail(new Error('Not implemented: GitLabPublisher.upsertSummary'));
  }
}
