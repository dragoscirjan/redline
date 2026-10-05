import { describe, expect, it } from 'vitest';
import { nodeProcessSpawner, parseJsonLines, readBounded, runBoundedProcess } from '../src/harness-executor/process-runner.js';

function textStream(chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk);
  })();
}

describe('readBounded', () => {
  it('reads a full stream under the limit', async () => {
    const result = await readBounded(textStream(['hello ', 'world']), 1024);
    expect(result).toEqual({ text: 'hello world', truncated: false });
  });

  it('drops bytes beyond the limit and reports truncation', async () => {
    const result = await readBounded(textStream(['abcdef', 'ghij']), 4);
    expect(result.text).toBe('abcd');
    expect(result.truncated).toBe(true);
  });

  it('rejects an invalid limit', async () => {
    await expect(readBounded(textStream(['x']), 0)).rejects.toThrow(/invalid/u);
  });
});

describe('runBoundedProcess', () => {
  it('captures stdout, stderr, and the exit code', async () => {
    const result = await runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err");'],
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('reports a non-zero exit code', async () => {
    const result = await runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(3);
  });

  it('kills a process that exceeds the timeout', async () => {
    const result = await runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 100)'],
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('reports a missing executable as a failed spawn', async () => {
    const result = await runBoundedProcess(nodeProcessSpawner, {
      command: 'redline-definitely-missing-binary',
      args: [],
      timeoutMs: 5_000,
    });
    expect(result.code).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('runs with a minimal constructed environment', async () => {
    const result = await runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.REDLINE_TEST_VALUE ?? "missing")'],
      env: { REDLINE_TEST_VALUE: 'present' },
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe('present');
  });
});

describe('parseJsonLines', () => {
  it('parses NDJSON and skips blank or malformed lines', () => {
    const events = parseJsonLines('{"a":1}\n\nnot json\n{"b":2}\n');
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
