import { describe, expect, it } from 'vitest';
import {
  createBoundedReader,
  nodeProcessSpawner,
  parseJsonLines,
  readBounded,
  runBoundedProcess,
} from '../src/harness-executor/process-runner.js';

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

  it('bounds the wait when a descendant inherits the output pipe', async () => {
    // The direct child exits immediately; a descendant inheriting stdout
    // keeps the pipe open, delaying `close` far beyond the timeout. The
    // post-kill wait must stay bounded and the stream readers must be
    // cancellable instead of blocking until the descendant exits.
    const result = await runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath,
      args: [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000);'],",
          "  { stdio: ['ignore', process.stdout, process.stderr] });",
        ].join(' '),
      ],
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(500);
    // Bounded by the kill grace period, not the descendant's 60s lifetime.
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it('preserves retained output when a reader is cancelled', async () => {
    const encoder = new TextEncoder();
    const blocking = (async function* (): AsyncIterable<Uint8Array> {
      yield encoder.encode('partial-');
      await new Promise(() => {
        // Never resolves: the stream stays open like a descendant-held pipe.
      });
    })();
    const reader = createBoundedReader(blocking, 1024);
    await new Promise((resolve) => setTimeout(resolve, 20));
    reader.cancel();
    const bounded = await reader.result();
    expect(bounded.text).toBe('partial-');
    expect(bounded.truncated).toBe(true);
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
