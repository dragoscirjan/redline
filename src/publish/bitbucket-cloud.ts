import { Effect } from 'effect';
import type { FileReviewPublication, ManagedObjectId, PublicationScope, ReviewPublisher } from './types.ts';

export class BitbucketCloudPublisher implements ReviewPublisher {
  currentHead(scope: PublicationScope): Effect.Effect<string | undefined, Error> {
    // Resolve Bitbucket Cloud PR identity/head without implying Server or Data Center support.
    return Effect.fail(new Error('Not implemented: BitbucketCloudPublisher.currentHead'));
  }

  publishFileReview(scope: PublicationScope, review: FileReviewPublication): Effect.Effect<ManagedObjectId, Error> {
    // Map validated inline locations through the Cloud API with bounded partial-failure handling.
    return Effect.fail(new Error('Not implemented: BitbucketCloudPublisher.publishFileReview'));
  }

  upsertSummary(scope: PublicationScope, body: string, marker: string): Effect.Effect<ManagedObjectId, Error> {
    // Update only the expected actor's marked Cloud summary comment.
    return Effect.fail(new Error('Not implemented: BitbucketCloudPublisher.upsertSummary'));
  }
}
