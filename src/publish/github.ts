import { Effect } from 'effect';
import type { FileReviewPublication, ManagedObjectId, PublicationScope, ReviewPublisher } from './types.ts';

export class GitHubPublisher implements ReviewPublisher {
  currentHead(scope: PublicationScope): Effect.Effect<string | undefined, Error> {
    // Resolve exact GitHub PR head using trusted event/API context.
    return Effect.fail(new Error('Not implemented: GitHubPublisher.currentHead'));
  }

  publishFileReview(scope: PublicationScope, review: FileReviewPublication): Effect.Effect<ManagedObjectId, Error> {
    // Map validated spans to GitHub inline positions while preserving marker/actor ownership.
    return Effect.fail(new Error('Not implemented: GitHubPublisher.publishFileReview'));
  }

  upsertSummary(scope: PublicationScope, body: string, marker: string): Effect.Effect<ManagedObjectId, Error> {
    // Upsert only the actor-owned marked summary; ambiguity must fail closed.
    return Effect.fail(new Error('Not implemented: GitHubPublisher.upsertSummary'));
  }
}
