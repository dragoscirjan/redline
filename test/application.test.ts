import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { ReviewApplication, type ReviewRequest } from '../src/application/review.ts';

describe('review application prototype', () => {
  it('accepts a review request but fails explicitly while its body is unimplemented', async () => {
    const request: ReviewRequest = {
      repository: '/unused/repository',
      base: 'base',
      target: { kind: 'revision', head: 'head', comparison: 'direct' },
    };
    const review = Effect.gen(function* () {
      const application = yield* ReviewApplication;
      return yield* application.review(request);
    }).pipe(Effect.provide(ReviewApplication.layer));

    await expect(Effect.runPromise(review)).rejects.toThrow('Not implemented');
  });
});
