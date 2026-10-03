import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export type ReviewBackend = 'pi' | 'opencode';
export type ContainerEngine = 'podman' | 'docker';

export type BackendReporting =
  | { backend: 'pi' }
  | { backend: 'opencode'; sessionId: string };

export interface BackendExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunningReviewBackend {
  reporting: BackendReporting;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  wait(): Promise<BackendExit>;
  stop(): Promise<void>;
  kill(): Promise<void>;
}

export interface ReviewBackendLauncher {
  start(input: {
    backend: ReviewBackend;
    prompt: string;
    signal: AbortSignal;
  }): Promise<RunningReviewBackend>;
}

export interface PreparedContainer {
  engine: ContainerEngine;
  id: string;
  backend: ReviewBackend;
  opencodeSessionId?: string;
}

export const MAX_BACKEND_OUTPUT_LINE_BYTES = 1024 * 1024;
export const MAX_BACKEND_STDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_BACKEND_STDERR_BYTES = 256 * 1024;

const CONTAINER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const ENGINE_COMMAND_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

function validatePreparedContainer(input: PreparedContainer): BackendReporting {
  if (input.engine !== 'podman' && input.engine !== 'docker') throw new Error('container engine is unsupported');
  if (!CONTAINER_ID_PATTERN.test(input.id)) throw new Error('prepared container id is invalid');
  if (input.backend === 'pi') {
    if (input.opencodeSessionId !== undefined) throw new Error('Pi does not accept an OpenCode session id');
    return { backend: 'pi' };
  }
  if (!input.opencodeSessionId || !SESSION_ID_PATTERN.test(input.opencodeSessionId)) {
    throw new Error('OpenCode requires a valid coordinator session id');
  }
  return { backend: 'opencode', sessionId: input.opencodeSessionId };
}

async function runEngineCommand(engine: ContainerEngine, arguments_: readonly string[]): Promise<void> {
  await execFileAsync(engine, [...arguments_], {
    timeout: ENGINE_COMMAND_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
}

export function createPreparedContainerLauncher(container: PreparedContainer): ReviewBackendLauncher {
  const reporting = validatePreparedContainer(container);
  return {
    async start(input) {
      if (input.backend !== container.backend) throw new Error('prepared container backend does not match the review backend');
      if (input.signal.aborted) throw new Error('backend launch was cancelled');

      const child = spawn(container.engine, ['start', '--attach', '--interactive', container.id], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        signal: input.signal,
      });
      if (!child.stdin || !child.stdout || !child.stderr) throw new Error('container process streams are unavailable');

      const exit = new Promise<BackendExit>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const promptWritten = new Promise<void>((resolve, reject) => {
        child.stdin?.once('error', reject);
        child.stdin?.end(input.prompt, 'utf8', resolve);
      });
      const wait = async (): Promise<BackendExit> => {
        const [result] = await Promise.all([exit, promptWritten]);
        return result;
      };

      return {
        reporting,
        stdout: child.stdout,
        stderr: child.stderr,
        wait,
        stop: () => runEngineCommand(container.engine, ['stop', '--time', '2', container.id]),
        kill: () => runEngineCommand(container.engine, ['kill', container.id]),
      };
    },
  };
}

function asBytes(chunk: Uint8Array): Uint8Array {
  return chunk;
}

export async function consumeBoundedLines(
  stream: AsyncIterable<Uint8Array>,
  onLine: (line: string) => Promise<void>,
  limits: { lineBytes?: number; totalBytes?: number } = {},
): Promise<void> {
  const lineLimit = limits.lineBytes ?? MAX_BACKEND_OUTPUT_LINE_BYTES;
  const totalLimit = limits.totalBytes ?? MAX_BACKEND_STDOUT_BYTES;
  if (!Number.isSafeInteger(lineLimit) || lineLimit <= 0) throw new Error('backend line byte limit is invalid');
  if (!Number.isSafeInteger(totalLimit) || totalLimit < lineLimit) throw new Error('backend total byte limit is invalid');

  let buffered = Buffer.alloc(0);
  let totalBytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const deliver = async (bytes: Uint8Array): Promise<void> => {
    let line = bytes;
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.length === 0) return;
    let decoded: string;
    try {
      decoded = decoder.decode(line);
    } catch {
      throw new Error('backend output line is not valid UTF-8');
    }
    await onLine(decoded);
  };

  for await (const rawChunk of stream) {
    const chunk = asBytes(rawChunk);
    totalBytes += chunk.byteLength;
    if (totalBytes > totalLimit) throw new Error('backend stdout exceeds its byte limit');
    buffered = Buffer.concat([buffered, chunk]);

    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > lineLimit) throw new Error('backend output line exceeds its byte limit');
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      await deliver(line);
    }
    if (buffered.byteLength > lineLimit) throw new Error('backend output line exceeds its byte limit');
  }

  if (buffered.byteLength > 0) await deliver(buffered);
}

export interface BoundedDiagnostic {
  text: string;
  truncated: boolean;
}

export async function collectBoundedDiagnostic(
  stream: AsyncIterable<Uint8Array>,
  byteLimit = MAX_BACKEND_STDERR_BYTES,
): Promise<BoundedDiagnostic> {
  if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) throw new Error('diagnostic byte limit is invalid');
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (retained >= byteLimit) continue;
    const remaining = byteLimit - retained;
    const selected = chunk.subarray(0, remaining);
    chunks.push(selected);
    retained += selected.byteLength;
  }
  return {
    text: new TextDecoder().decode(Buffer.concat(chunks)),
    truncated: total > byteLimit,
  };
}
