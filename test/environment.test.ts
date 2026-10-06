import { describe, expect, it } from 'vitest';
import { parseReviewEnvironment, parseModelConfig, selectModelCredential } from '../src/review/environment.js';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.js';

const MODEL_CONFIG = JSON.stringify({ provider: 'mock', endpoint: 'http://127.0.0.1:8787/v1', model: 'test-model' });
const MODEL_AUTH = JSON.stringify({ mock: 'test-key' });

describe('parseReviewEnvironment', () => {
  it('returns context-only mode when no review inputs are provided', () => {
    const parsed = parseReviewEnvironment({});
    expect(parsed.mode).toBe('context-only');
    expect(parsed.review).toBeUndefined();
    expect(parsed.timeout.minutes).toBe(30);
  });

  it('validates optional values even in context-only mode', () => {
    expect(() => parseReviewEnvironment({ REDLINE_FINDING_SCOPE: 'everything' })).toThrow(
      /finding scope is unsupported/u,
    );
    expect(() => parseReviewEnvironment({ REDLINE_TIMEOUT: 'nope' })).toThrow(/not a valid duration/u);
  });

  it('rejects unknown REDLINE_* variables', () => {
    expect(() => parseReviewEnvironment({ REDLINE_HARNESSS: 'pi' })).toThrow(
      /unknown REDLINE_\* environment variable: REDLINE_HARNESSS/u,
    );
  });

  it('requires every review input together', () => {
    const partial = {
      REDLINE_HARNESS: 'pi',
      REDLINE_MODEL_CONFIG: MODEL_CONFIG,
      REDLINE_MODEL_AUTH: MODEL_AUTH,
    };
    const message = (() => {
      try {
        parseReviewEnvironment(partial);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();
    expect(message).toMatch(/together/u);
    expect(message).toMatch(/missing: REDLINE_REVIEW_DIR, REDLINE_SOURCE_DIR, REDLINE_OUTPUT_DIR/u);
  });

  it('rejects an unsupported harness', () => {
    const base = {
      REDLINE_HARNESS: 'claude',
      REDLINE_REVIEW_DIR: '/tmp/review',
      REDLINE_SOURCE_DIR: '/tmp/source',
      REDLINE_OUTPUT_DIR: '/tmp/output',
      REDLINE_MODEL_CONFIG: MODEL_CONFIG,
      REDLINE_MODEL_AUTH: MODEL_AUTH,
    };
    expect(() => parseReviewEnvironment(base)).toThrow(/REDLINE_HARNESS is unsupported/u);
  });

  it('parses a complete review environment', async () => {
    const fixture = await createBundleFixture();
    try {
      const parsed = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      expect(parsed.mode).toBe('review');
      expect(parsed.review?.harness).toBe('echo');
      expect(parsed.review?.model.provider).toBe('mock');
      expect(parsed.review?.model.endpoint).toBe('http://127.0.0.1:8787/v1');
      expect(parsed.review?.credential).toEqual({ provider: 'mock', value: 'test-key' });
      expect(parsed.review?.findingScope).toBe('defects');
      expect(parsed.review?.timeout.minutes).toBe(30);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts defects-and-risks and a custom timeout', () => {
    const parsed = parseReviewEnvironment({
      REDLINE_HARNESS: 'pi',
      REDLINE_REVIEW_DIR: '/tmp/review',
      REDLINE_SOURCE_DIR: '/tmp/source',
      REDLINE_OUTPUT_DIR: '/tmp/output',
      REDLINE_MODEL_CONFIG: MODEL_CONFIG,
      REDLINE_MODEL_AUTH: MODEL_AUTH,
      REDLINE_FINDING_SCOPE: 'defects-and-risks',
      REDLINE_TIMEOUT: '10m',
    });
    expect(parsed.review?.findingScope).toBe('defects-and-risks');
    expect(parsed.review?.timeout.minutes).toBe(10);
  });
});

describe('publication environment', () => {
  const PUBLICATION = {
    REDLINE_PUBLISH_TOKEN: 'gh-token',
    REDLINE_REPOSITORY: 'owner/repository',
    REDLINE_PULL_REQUEST: '14',
    REDLINE_HEAD: 'b'.repeat(40),
  };

  it('is absent without publication variables', () => {
    expect(parseReviewEnvironment({}).publication).toBeUndefined();
  });

  it('parses the complete publication context in review mode', async () => {
    const fixture = await createBundleFixture();
    try {
      const parsed = parseReviewEnvironment({
        ...cleanReviewEnvironment(fixture, 'echo'),
        ...PUBLICATION,
      });
      expect(parsed.publication).toEqual({
        token: 'gh-token',
        repository: 'owner/repository',
        pullRequest: 14,
        head: 'b'.repeat(40),
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects partial publication contexts', () => {
    expect(() => parseReviewEnvironment({ ...PUBLICATION, REDLINE_HEAD: '' })).toThrow(
      /publication requires .* together; missing: REDLINE_HEAD/u,
    );
  });

  it('rejects publication without review execution', () => {
    expect(() => parseReviewEnvironment(PUBLICATION)).toThrow(/publication requires review execution/u);
  });

  it('validates repository, pull request, and head shapes', async () => {
    const fixture = await createBundleFixture();
    try {
      const base = cleanReviewEnvironment(fixture, 'echo');
      expect(() => parseReviewEnvironment({ ...base, ...PUBLICATION, REDLINE_REPOSITORY: 'owner name' })).toThrow(
        /REDLINE_REPOSITORY must use owner\/name syntax/u,
      );
      expect(() => parseReviewEnvironment({ ...base, ...PUBLICATION, REDLINE_PULL_REQUEST: '0' })).toThrow(
        /REDLINE_PULL_REQUEST must be a pull request number/u,
      );
      expect(() => parseReviewEnvironment({ ...base, ...PUBLICATION, REDLINE_HEAD: 'abc' })).toThrow(
        /REDLINE_HEAD must be a full commit identifier/u,
      );
      expect(() => parseReviewEnvironment({ ...base, ...PUBLICATION, REDLINE_PUBLISH_TOKEN: ' spaced ' })).toThrow(
        /publication token is invalid/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('parseModelConfig', () => {
  it('rejects malformed JSON, non-objects, and unknown fields', () => {
    expect(() => parseModelConfig('not json')).toThrow(/valid JSON/u);
    expect(() => parseModelConfig('[]')).toThrow(/JSON object/u);
    expect(() => parseModelConfig(JSON.stringify({ provider: 'a', endpoint: 'http://x', model: 'm', extra: 1 }))).toThrow(
      /unsupported field/u,
    );
  });

  it('rejects non-http and non-absolute endpoints', () => {
    // WHATWG URLs parse 'localhost:1234' with a custom scheme, so the
    // protocol check is what catches it.
    expect(() => parseModelConfig(JSON.stringify({ provider: 'a', endpoint: 'localhost:1234', model: 'm' }))).toThrow(
      /http or https/u,
    );
    expect(() => parseModelConfig(JSON.stringify({ provider: 'a', endpoint: 'not a url', model: 'm' }))).toThrow(
      /absolute URL/u,
    );
    expect(() => parseModelConfig(JSON.stringify({ provider: 'a', endpoint: 'ftp://x', model: 'm' }))).toThrow(
      /http or https/u,
    );
  });

  it('rejects invalid provider names', () => {
    expect(() =>
      parseModelConfig(JSON.stringify({ provider: 'not valid!', endpoint: 'http://127.0.0.1:1/v1', model: 'm' })),
    ).toThrow(/provider is invalid/u);
  });
});

describe('selectModelCredential', () => {
  const model = { provider: 'mock', endpoint: 'http://127.0.0.1:8787/v1', model: 'test-model' };

  it('selects the entry for the configured provider', () => {
    expect(selectModelCredential(model, JSON.stringify({ mock: 'k', other: 'x' }))).toEqual({
      provider: 'mock',
      value: 'k',
    });
  });

  it('rejects a missing provider entry and invalid values', () => {
    expect(() => selectModelCredential(model, JSON.stringify({ other: 'x' }))).toThrow(/no entry/u);
    expect(() => selectModelCredential(model, JSON.stringify({ mock: ' ' }))).toThrow(/credential is invalid/u);
    expect(() => selectModelCredential(model, JSON.stringify({ mock: 42 }))).toThrow(/credential is invalid/u);
  });
});
