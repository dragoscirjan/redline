/**
 * Bounded child-process execution shared by the harness executors.
 *
 * Every harness runs as a plain argument-array child process with tools
 * disabled and its environment constructed from scratch, so no ambient
 * state (credentials, GitHub tokens, shell configuration) reaches the
 * harness. Output is captured under hard byte limits and each run is
 * bounded by a timeout that kills the child.
 */

import { spawn } from 'node:child_process';

export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const TIMEOUT_KILL_GRACE_MS = 2_000;

export interface SpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SpawnedProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  wait(): Promise<{ readonly code: number | null; readonly error?: string }>;
  kill(): void;
}

export interface ProcessSpawner {
  spawn(request: SpawnRequest): SpawnedProcess;
}

function emptyStream(): AsyncIterable<Uint8Array> {
  return (async function* () {
    /* empty */
  })();
}

/** Default spawner backed by node:child_process. */
export const nodeProcessSpawner: ProcessSpawner = {
  spawn(request) {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // The exit promise is memoized: `close` and `error` fire once, so a
    // fresh listener per wait() call would hang forever after the first.
    const exit = new Promise<{ code: number | null; error?: string }>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        resolve({ code: null, error: error.message });
      });
      child.once('close', (code) => {
        resolve({ code });
      });
    });
    return {
      stdout: child.stdout ?? emptyStream(),
      stderr: child.stderr ?? emptyStream(),
      wait: () => exit,
      kill: () => {
        child.kill('SIGKILL');
      },
    };
  },
};

export interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

export interface BoundedStreamReader {
  /** Resolves with the full bounded text when the stream ends, or the retained prefix after `cancel()`. */
  result(): Promise<BoundedText>;
  /** Ends collection early, resolving `result()` with what was retained so far. */
  cancel(): void;
}

/**
 * Reads a stream fully, retaining at most `maximumBytes`. Bytes beyond the
 * limit are counted and dropped, never buffered. Invalid UTF-8 decodes with
 * replacement characters; harness output that is not valid UTF-8 fails later
 * schema parsing anyway. The reader can be cancelled, which keeps a
 * descendant-held pipe from blocking the caller forever.
 */
export function createBoundedReader(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): BoundedStreamReader {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error('bounded read limit is invalid');
  }
  const chunks: Buffer[] = [];
  let retained = 0;
  let total = 0;
  let cancelled = false;
  let resolveResult!: (value: BoundedText) => void;
  const result = new Promise<BoundedText>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (): void => {
    resolveResult({
      text: new TextDecoder().decode(Buffer.concat(chunks)),
      truncated: cancelled || total > retained,
    });
  };
  void (async () => {
    try {
      for await (const chunk of stream) {
        if (cancelled) break;
        total += chunk.byteLength;
        if (retained >= maximumBytes) continue;
        const selected = chunk.subarray(0, maximumBytes - retained);
        chunks.push(Buffer.from(selected.buffer, selected.byteOffset, selected.byteLength));
        retained += selected.byteLength;
      }
    } catch {
      // A stream error ends collection with whatever was retained.
    }
    finish();
  })();
  return {
    result: () => result,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      finish();
    },
  };
}

/** Reads a stream fully under a byte limit; see `createBoundedReader`. */
export async function readBounded(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<BoundedText> {
  return createBoundedReader(stream, maximumBytes).result();
}

export interface BoundedRunRequest extends SpawnRequest {
  readonly timeoutMs: number;
}

export interface BoundedRunResult {
  readonly code: number | null;
  readonly error?: string | undefined;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly durationMs: number;
}

/** Runs one child process under byte and time limits. */
export async function runBoundedProcess(
  spawner: ProcessSpawner,
  request: BoundedRunRequest,
): Promise<BoundedRunResult> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error('process timeout is invalid');
  }
  const startedAt = Date.now();
  const child = spawner.spawn(request);
  const stdoutReader = createBoundedReader(child.stdout, MAX_OUTPUT_BYTES);
  const stderrReader = createBoundedReader(child.stderr, MAX_DIAGNOSTIC_BYTES);

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      child.wait().then((result): { kind: 'exit'; result: { code: number | null; error?: string } } => ({
        kind: 'exit' as const,
        result,
      })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill();
          resolve({ kind: 'timeout' as const });
        }, request.timeoutMs);
      }),
    ]);

    let exit: { code: number | null; error?: string | undefined };
    if (outcome.kind === 'exit') {
      exit = outcome.result;
    } else {
      // SIGKILL reaches only the direct child. A descendant that inherited
      // an output pipe can keep `close` from firing long after the kill, so
      // the post-kill wait is bounded and the stream readers are cancelled
      // with whatever they retained instead of blocking past the timeout.
      const settled = await Promise.race([
        child.wait().then(
          (result): { done: true; result: { code: number | null; error?: string | undefined } } => ({
            done: true as const,
            result,
          }),
        ),
        new Promise<{ done: false }>((resolve) => {
          graceTimer = setTimeout(() => resolve({ done: false as const }), TIMEOUT_KILL_GRACE_MS);
        }),
      ]);
      if (settled.done) {
        exit = settled.result;
      } else {
        stdoutReader.cancel();
        stderrReader.cancel();
        exit = { code: null, error: 'process did not exit before the kill grace period' };
      }
    }

    const [stdout, stderr] = await Promise.all([stdoutReader.result(), stderrReader.result()]);
    return {
      code: exit.code,
      error: exit.error,
      timedOut,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses newline-delimited JSON, ignoring blank lines and non-JSON noise.
 * Returns the parsed events in order, with malformed lines skipped.
 */
export function parseJsonLines(stdout: string): ReadonlyArray<Record<string, unknown>> {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}
