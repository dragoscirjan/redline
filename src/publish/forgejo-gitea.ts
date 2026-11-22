import { Effect } from 'effect';
import type { FileReviewPublication, ManagedObjectId, PublicationScope, ReviewPublisher } from './types.ts';

export class ForgejoGiteaPublisher implements ReviewPublisher {
  currentHead(scope: PublicationScope): Effect.Effect<string | undefined, Error> {
    // Detect Forgejo/Gitea capabilities explicitly and resolve exact head without assuming GitHub compatibility.
    return Effect.fail(new Error('Not implemented: ForgejoGiteaPublisher.currentHead'));
  }

  publishFileReview(scope: PublicationScope, review: FileReviewPublication): Effect.Effect<ManagedObjectId, Error> {
    // Share only genuinely compatible APIs and keep separate native position/capability behavior.
    return Effect.fail(new Error('Not implemented: ForgejoGiteaPublisher.publishFileReview'));
  }

  upsertSummary(scope: PublicationScope, body: string, marker: string): Effect.Effect<ManagedObjectId, Error> {
    // Apply each forge's actor/marker ownership rules without adopting arbitrary comments.
    return Effect.fail(new Error('Not implemented: ForgejoGiteaPublisher.upsertSummary'));
  }
}
