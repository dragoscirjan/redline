import { describe, expect, it } from 'vitest';
import { classifyModelFailure, redactModelFailure } from '../src/harness-executor/model-failure.ts';
import { piFailureDiagnostic, readPiFailure } from '../src/harness-executor/pi-failure.ts';
import { parseReviewRetries, reviewRetryReason } from '../src/review/retries.ts';

const frame = (errorMessage: string) => JSON.stringify({ type: 'turn_end', message: { role: 'assistant', stopReason: 'error', errorMessage } });

const formEncoded = (value: string): string => new URLSearchParams({ key: value }).toString().slice(4);
const strictEncoded = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/gu,
  (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
const lowerHex = (value: string): string => value.replace(/%(?:25)?[0-9A-F]{2}/gu, (match) => match.toLowerCase());

describe('runtime retry classification', () => {
  it.each([
    ['URL component', encodeURIComponent],
    ['strict RFC 3986', strictEncoded],
    ['lowercase strict escapes', (value: string) => lowerHex(strictEncoded(value))],
    ['double strict encoding', (value: string) => strictEncoded(strictEncoded(value))],
    ['strict over URL encoding', (value: string) => strictEncoded(encodeURIComponent(value))],
    ['URL over strict encoding', (value: string) => encodeURIComponent(strictEncoded(value))],
    ['strict over form encoding', (value: string) => strictEncoded(formEncoded(value))],
    ['form over strict encoding', (value: string) => formEncoded(strictEncoded(value))],
    ['lowercase URL escapes', (value: string) => lowerHex(encodeURIComponent(value))],
    ['form encoding', formEncoded],
    ['lowercase form escapes', (value: string) => lowerHex(formEncoded(value))],
    ['double URL encoding', (value: string) => encodeURIComponent(encodeURIComponent(value))],
    ['double form encoding', (value: string) => formEncoded(formEncoded(value))],
    ['URL over form encoding', (value: string) => encodeURIComponent(formEncoded(value))],
    ['form over URL encoding', (value: string) => formEncoded(encodeURIComponent(value))],
    ['lowercase inner double escapes', (value: string) => encodeURIComponent(lowerHex(encodeURIComponent(value)))],
    ['mixed percent-escape case', (value: string) => encodeURIComponent(value).replace('%2F', '%2f')],
  ] satisfies [string, (value: string) => string][])('redacts %s without changing unrelated diagnostics', (_label, encode) => {
    const credential = 'Fixture key+/é"' + "!'()*";
    const encoded = encode(credential);
    expect(redactModelFailure(`unchanged %2f ${encoded} tail %252f`, credential)).toBe('unchanged %2f [redacted] tail %252f');
    const failure = readPiFailure(frame(`HTTP 503 ${encoded}`), undefined, credential, true);
    if (failure === undefined) throw new Error('expected runtime failure');
    const persisted = piFailureDiagnostic(failure);
    expect(JSON.parse(persisted)).toMatchObject({ status: 503, scope: 'file', retryable: true, message: 'HTTP 503 [redacted]' });
    expect(persisted.length).toBeLessThanOrEqual(500);
  });

  it('covers the literal RFC example without dropping the legacy mixed encoding', () => {
    expect(redactModelFailure('abc%21def%2Aghi', 'abc!def*ghi')).toBe('[redacted]');
    expect(redactModelFailure('!%2F', '!/')).toBe('[redacted]');
  });

  it('preserves case-sensitive key characters outside percent escapes', () => {
    expect(redactModelFailure('abc%2fXY AbC%2fXY', 'AbC/XY')).toBe('abc%2fXY [redacted]');
  });

  it('handles long encoded credentials and regex punctuation without dynamic secret regexes', () => {
    const credential = 'Ab/'.repeat(4_096);
    expect(redactModelFailure(lowerHex(encodeURIComponent(encodeURIComponent(credential))), credential)).toBe('[redacted]');
    const punctuation = 'key[.*+?^${}()|] /';
    expect(redactModelFailure(formEncoded(formEncoded(punctuation)), punctuation)).toBe('[redacted]');
  });
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
