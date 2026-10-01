import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  parseDuration,
} from '../src/duration.js';

function thrownMessage(callback: () => unknown): string {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  return caught.message;
}

test('parses single-unit durations', () => {
  assert.deepEqual(parseDuration('10m'), { minutes: 10, milliseconds: 600_000 });
  assert.deepEqual(parseDuration('2h'), { minutes: 120, milliseconds: 7_200_000 });
  assert.deepEqual(parseDuration('360m'), { minutes: 360, milliseconds: 21_600_000 });
});

test('parses compound durations', () => {
  assert.deepEqual(parseDuration('1h30m'), { minutes: 90, milliseconds: 5_400_000 });
  assert.deepEqual(parseDuration('1h'), { minutes: 60, milliseconds: 3_600_000 });
  assert.deepEqual(parseDuration('30m'), { minutes: 30, milliseconds: 1_800_000 });
});

test('exposes the documented default and cap', () => {
  assert.equal(DEFAULT_TIMEOUT_MINUTES, 30);
  assert.equal(MAX_TIMEOUT_MINUTES, 360);
});

test('rejects day values above the 360-minute cap without clamping', () => {
  const message = thrownMessage(() => parseDuration('1d'));
  assert.match(message, /exceeds the 360-minute cap/u);
  const capped = thrownMessage(() => parseDuration('361m'));
  assert.match(capped, /exceeds the 360-minute cap/u);
});

test('rejects malformed durations', () => {
  for (const raw of ['', '   ', ' 10m', '10m ', 'm', '1.5h', '-10m', '+10m', '10s', '0m', '00m', '10M', '2H']) {
    thrownMessage(() => parseDuration(raw));
  }
  assert.match(thrownMessage(() => parseDuration('1.5h')), /not a valid duration/u);
  assert.match(thrownMessage(() => parseDuration('10s')), /not a valid duration/u);
  assert.match(thrownMessage(() => parseDuration('0m')), /positive duration/u);
  assert.match(thrownMessage(() => parseDuration('10m 30s')), /not a valid duration/u);
});

test('rejects out-of-order compound components', () => {
  assert.throws(() => parseDuration('30m1h'));
  assert.match(thrownMessage(() => parseDuration('30m1h')), /not a valid duration/u);
});
