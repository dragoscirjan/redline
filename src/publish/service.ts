import { Effect } from 'effect';
import type { OperationalEvents } from '../observability/service.ts';
import type { ArtifactReference, ReviewWriter } from '../review/writer.ts';
import type { PublicationAuthorization, PublicationReceipt, PublicationScope, ReviewPublisher } from './types.ts';

export interface PublicationDependencies {
  readonly artifacts: ReviewWriter;
  readonly publisher: ReviewPublisher;
  readonly events: OperationalEvents;
}

export class PublicationService {
  publish(artifact: ArtifactReference, scope: PublicationScope, authorization: PublicationAuthorization, dependencies: PublicationDependencies): Effect.Effect<PublicationReceipt, Error> {
    // Replay only authorized validated JSON, check stale head/ownership and enforce caps with bounded partial-failure receipts.
    // Never rerun models or accept parseable contributor JSON as permission to publish.
    return Effect.fail(new Error('Not implemented: PublicationService.publish'));
  }
}
