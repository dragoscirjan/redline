import { Effect } from 'effect';
import type { FileReviewPublication, ManagedObjectId, PublicationScope, ReviewPublisher } from './types.ts';

export class AzureDevOpsPublisher implements ReviewPublisher {
  currentHead(scope: PublicationScope): Effect.Effect<string | undefined, Error> {
    // Resolve the separately agreed Azure DevOps deployment, API and auth scope; this is not Azure OpenAI.
    return Effect.fail(new Error('Not implemented: AzureDevOpsPublisher.currentHead'));
  }

  publishFileReview(scope: PublicationScope, review: FileReviewPublication): Effect.Effect<ManagedObjectId, Error> {
    // Map validated spans to native pull-request threads without promising every Services/Server variant.
    return Effect.fail(new Error('Not implemented: AzureDevOpsPublisher.publishFileReview'));
  }

  upsertSummary(scope: PublicationScope, body: string, marker: string): Effect.Effect<ManagedObjectId, Error> {
    // Maintain an authorized marked summary under native identity and capability rules.
    return Effect.fail(new Error('Not implemented: AzureDevOpsPublisher.upsertSummary'));
  }
}
