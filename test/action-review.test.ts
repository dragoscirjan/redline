import { describe, expect, it } from 'vitest';
import { requireActionFollowUpConfig } from '../src/action/review.js';

describe('action-owned verification configuration', () => {
  const valid = {
    CODE_INDEX_VERIFICATION_ENABLED: 'true',
    CODE_INDEX_PROVIDER: 'cgc',
    RUNNER_TEMP: '/trusted/runner-temp',
    REDLINE_REVIEW_DIR: '/trusted/review-bundle',
  };

  it('rejects empty path values before constructing a follow-up executor', () => {
    for (const invalid of [
      { RUNNER_TEMP: '' },
      { REDLINE_REVIEW_DIR: '' },
      { CODE_INDEX_PROVIDER: '' },
    ]) {
      expect(() => requireActionFollowUpConfig({ ...valid, ...invalid }))
        .toThrow('action-owned verification requires a pinned provider and review bundle');
    }
  });

  it('passes only the selected provider and paths to the trusted adapter', () => {
    expect(requireActionFollowUpConfig(valid)).toEqual({
      provider: 'cgc', runnerTemp: valid.RUNNER_TEMP, reviewDirectory: valid.REDLINE_REVIEW_DIR,
    });
  });
});
