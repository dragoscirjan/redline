import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/benchmark/performance-cli.js';

const CORPUS = resolve('benchmark/performance/v1/corpus.json');
const PROFILE = resolve('benchmark/performance/v1/profile.json');
const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

afterEach(() => {
  stderr.mockClear();
});

describe('performance benchmark CLI', () => {
  it('requires an explicit opt in before live execution', async () => {
    await expect(main([
      '--live',
      '--corpus', CORPUS,
      '--profile', PROFILE,
      '--output', '/tmp/redline-performance-live',
    ], {})).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('set REDLINE_LIVE_BENCHMARK=1'));
  });

  it('requires a caller-selected output directory for live artifacts', async () => {
    await expect(main([
      '--live',
      '--corpus', CORPUS,
      '--profile', PROFILE,
    ], {})).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--output is required'));
  });

  it('rejects the deterministic echo harness as a live model', async () => {
    await expect(main([
      '--live',
      '--corpus', CORPUS,
      '--profile', PROFILE,
      '--output', '/tmp/redline-performance-live',
    ], {
      REDLINE_LIVE_BENCHMARK: '1',
      REDLINE_HARNESS: 'echo',
    })).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('must select pi or opencode'));
  });
});
