import { describe, expect, it } from 'vitest';
import { classifyModelFailure, redactModelFailure } from '../src/harness-executor/model-failure.ts';
import { readPiFailure } from '../src/harness-executor/pi-failure.ts';
import { parseReviewRetries, reviewRetryReason } from '../src/review/retries.ts';

const frame = (errorMessage: string) => JSON.stringify({ type: 'turn_end', message: { role: 'assistant', stopReason: 'error', errorMessage } });

describe('runtime retry classification', () => {
  it.each(['', ' ', '\n\t'])('uses a supplied fallback for a blank Pi error %j', (blank) => {
    expect(readPiFailure(frame(blank), 'HTTP 401 Invalid API key')).toMatchObject({ status: 401, scope: 'run', retryable: false });
    expect(readPiFailure(frame(blank), 'HTTP 503 unavailable')).toMatchObject({ status: 503, scope: 'file', retryable: true });
  });
  it('recognizes uncoded upstream server errors only for caller-managed policy', () => {
    const message = 'Upstream error from OpenInference: Internal server error';
    expect(classifyModelFailure(message)).toMatchObject({ status: null, scope: 'file', retryable: false });
    expect(classifyModelFailure(message, true)).toMatchObject({ status: null, scope: 'file', retryable: true });
    expect(readPiFailure(frame(message), undefined, undefined, true)?.retryable).toBe(true);
    expect(classifyModelFailure('unknown failure', true).retryable).toBe(false);
  });
  it.each([
    'HTTP 401 Invalid API key', 'HTTP 402 Payment required', 'HTTP 404 model not found',
    'HTTP 400 Reasoning is mandatory for this endpoint and cannot be disabled.',
    'unsupported request parameter response_format',
  ])('keeps shared configuration failures nonretryable: %s', (message) => {
    expect(classifyModelFailure(message, true)).toMatchObject({ scope: 'run', retryable: false });
  });
  it('redacts every selected-credential encoding before classification or serialization', () => {
    const credential = 'secret"key';
    const text = [credential, JSON.stringify(credential).slice(1, -1), encodeURIComponent(credential)].join(' ');
    expect(redactModelFailure(text, credential)).toBe('[redacted] [redacted] [redacted]');
  });
});

describe('bounded retry selection', () => {
  it.each(['0', '3', '10'])('accepts %s additional retries', (value) => expect(parseReviewRetries(value)).toBe(Number(value)));
  it.each(['-1', '11', '1.5', 'Infinity', '', ' 3', '03', '99999999999999999999999'])('rejects %j', (value) => {
    expect(() => parseReviewRetries(value)).toThrow(/retries must be an integer/u);
  });
  it('does not treat arbitrary omissions as source requests', () => {
    // The selector consumes only this bounded projection of a completed record.
    expect(reviewRetryReason({ outcome: 'omitted', reason: 'unclassified refusal' }, false)).toBeUndefined();
  });
});
