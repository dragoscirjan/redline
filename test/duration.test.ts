import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES, parseDuration } from '../src/duration.js';

function thrownMessage(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error('callback did not throw');
}

describe('parseDuration', () => {
  it('parses single-unit durations', () => {
    expect(parseDuration('10m')).toEqual({ minutes: 10, milliseconds: 600_000 });
    expect(parseDuration('2h')).toEqual({ minutes: 120, milliseconds: 7_200_000 });
    expect(parseDuration('360m')).toEqual({ minutes: 360, milliseconds: 21_600_000 });
  });

  it('parses compound durations', () => {
    expect(parseDuration('1h30m')).toEqual({ minutes: 90, milliseconds: 5_400_000 });
  });

  it('exposes the documented default and cap', () => {
    expect(DEFAULT_TIMEOUT_MINUTES).toBe(30);
    expect(MAX_TIMEOUT_MINUTES).toBe(360);
  });

  it('rejects day values above the 360-minute cap without clamping', () => {
    expect(thrownMessage(() => parseDuration('1d'))).toMatch(/exceeds the 360-minute cap/u);
    expect(thrownMessage(() => parseDuration('361m'))).toMatch(/exceeds the 360-minute cap/u);
  });

  it('rejects malformed durations', () => {
    for (const raw of ['', '   ', ' 10m', '10m ', 'm', '1.5h', '-10m', '+10m', '10s', '0m', '00m', '10M', '2H']) {
      expect(() => parseDuration(raw)).toThrow();
    }
    expect(thrownMessage(() => parseDuration('1.5h'))).toMatch(/not a valid duration/u);
    expect(thrownMessage(() => parseDuration('0m'))).toMatch(/positive duration/u);
  });

  it('rejects out-of-order compound components', () => {
    expect(thrownMessage(() => parseDuration('30m1h'))).toMatch(/not a valid duration/u);
  });
});
