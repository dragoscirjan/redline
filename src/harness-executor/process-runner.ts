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

/**
 * Reads a stream fully, retaining at most `maximumBytes`. Bytes beyond the
 * limit are counted and dropped, never buffered. Invalid UTF-8 decodes with
 * replacement characters; harness output that is not valid UTF-8 fails later
 * schema parsing anyway.
 */
export async function readBounded(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<BoundedText> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error('bounded read limit is invalid');
  }
  const chunks: Buffer[] = [];
  let retained = 0;
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (retained >= maximumBytes) continue;
    const selected = chunk.subarray(0, maximumBytes - retained);
    chunks.push(Buffer.from(selected.buffer, selected.byteOffset, selected.byteLength));
    retained += selected.byteLength;
  }
  return {
    text: new TextDecoder().decode(Buffer.concat(chunks)),
    truncated: total > retained,
  };
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
  const stdoutPromise = readBounded(child.stdout, MAX_OUTPUT_BYTES);
  const stderrPromise = readBounded(child.stderr, MAX_DIAGNOSTIC_BYTES);

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
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
    if (outcome.kind === 'timeout') {
      // The kill above races the child's own shutdown; give it a short grace
      // period so stream readers observe end-of-stream and exit codes settle.
      const grace = new Promise<void>((resolve) => {
        const graceTimer = setTimeout(resolve, TIMEOUT_KILL_GRACE_MS);
        void child.wait().then(() => {
          clearTimeout(graceTimer);
          resolve();
        });
      });
      await grace;
    }
    const exit = outcome.kind === 'exit' ? outcome.result : await child.wait();
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
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
