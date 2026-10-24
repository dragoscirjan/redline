import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_BYTES,
  createBoundedReader,
  nodeProcessSpawner,
  parseJsonLines,
  readBounded,
  runBoundedProcess,
} from '../src/harness-executor/process-runner.ts';

function textStream(chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk);
  })();
}

describe('readBounded', () => {
  it('reads a full stream under the limit', async () => {
    const result = await readBounded(textStream(['hello ', 'world']), 1024);
    expect(result).toEqual({ text: 'hello world', truncated: false, retainedBytes: 11, totalBytes: 11 });
  });

  it('drops bytes beyond the limit and reports truncation', async () => {
    const result = await readBounded(textStream(['abcdef', 'ghij']), 4);
    expect(result).toMatchObject({ text: 'abcd', truncated: true, retainedBytes: 4, totalBytes: 10 });
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
    expect(result).toMatchObject({
      stdoutBytes: 3,
      stderrBytes: 3,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(result.processStartupMs).toBeGreaterThanOrEqual(0);
  });

  it('streams prompts larger than the operating-system argument limit through bounded stdin', async () => {
    const input = 'review context: ' + 'x'.repeat(256 * 1024);
    const result = await runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath,
      args: ['-e', 'let size = 0; process.stdin.on("data", (part) => size += part.length); '
        + 'process.stdin.on("end", () => process.stdout.write(String(size)));'],
      stdin: input,
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(String(Buffer.byteLength(input, 'utf8')));
    await expect(runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath, args: ['-e', 'process.exit(0)'],
      stdin: 'x'.repeat(MAX_INPUT_BYTES + 1), timeoutMs: 10_000,
    })).rejects.toThrow('input exceeds its byte limit');
    const multibyte = 'α'.repeat(MAX_INPUT_BYTES);
    expect(multibyte.length).toBe(MAX_INPUT_BYTES);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(MAX_INPUT_BYTES);
    await expect(runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath, args: ['-e', 'process.exit(0)'],
      stdin: multibyte, timeoutMs: 10_000,
    })).rejects.toThrow('input exceeds its byte limit');
  });

  it('reports a non-zero exit code', async () => {
    const result = await runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(3);
  });

  it('taps output lines live while collection stays unchanged', async () => {
    const tapped: string[] = [];
    const result = await runBoundedProcess(nodeProcessSpawner, {
      command: process.execPath,
      // Multibyte characters split across chunk boundaries must not
      // corrupt either the tapped lines or the collected text.
      args: ['-e', 'process.stdout.write("\\u03b1\\n\\u03b2\\n\\u03b3"); process.stderr.write("diag\\n");'],
      timeoutMs: 10_000,
      onOutputLine: (stream, line) => tapped.push(`${stream}:${line}`),
    });
    expect(result.stdout).toBe('α\nβ\nγ');
    expect(result.stderr).toBe('diag\n');
    // Two independent pipes: per-stream order is guaranteed, cross-stream
    // order is not.
    expect(tapped.filter((line) => line.startsWith('stdout:'))).toEqual(['stdout:α', 'stdout:β', 'stdout:γ']);
    expect(tapped.filter((line) => line.startsWith('stderr:'))).toEqual(['stderr:diag']);
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
    expect(bounded).toMatchObject({
      text: 'partial-',
      truncated: true,
      retainedBytes: 8,
      totalBytes: 8,
    });
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
