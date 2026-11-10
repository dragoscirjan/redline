import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/benchmark/live-cli.ts';

const CORPUS = resolve('benchmark/review-quality/v2');

const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

afterEach(() => {
  stderr.mockClear();
});

describe('live review-quality benchmark', () => {
  it('requires an explicit live-evaluation opt in', async () => {
    await expect(main([
      '--corpus', CORPUS,
      '--output', '/tmp/redline-live-benchmark.json',
    ], {})).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('set REDLINE_LIVE_BENCHMARK=1'),
    );
  });

  it('rejects the deterministic echo harness as a live model', async () => {
    await expect(main([
      '--corpus', CORPUS,
      '--output', '/tmp/redline-live-benchmark.json',
    ], {
      REDLINE_LIVE_BENCHMARK: '1',
      REDLINE_HARNESS: 'echo',
    })).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('must select pi or opencode'),
    );
  });
});
