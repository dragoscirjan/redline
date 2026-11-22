import { Effect } from 'effect';
import type { ReviewDocument } from './types.ts';

export type ReviewReuseIdentity = unknown;
export type ReviewReuseLookup = unknown;
export type ReuseTrustContext = unknown;

export class ReviewReuseStore {
  lookup(identity: ReviewReuseIdentity, trust: ReuseTrustContext): Effect.Effect<ReviewReuseLookup, Error> {
    // Distinguish disabled/miss/hit and validate repository, source, policy, tool and driver/binding identity before reuse.
    // Opaque external tool inputs must not silently become cacheable answers.
    return Effect.fail(new Error('Not implemented: ReviewReuseStore.lookup'));
  }

  persist(identity: ReviewReuseIdentity, document: ReviewDocument, trust: ReuseTrustContext): Effect.Effect<void, Error> {
    // Persist only trusted compatible results; keep provider-owned index state separate from answer reuse.
    return Effect.fail(new Error('Not implemented: ReviewReuseStore.persist'));
  }
}
