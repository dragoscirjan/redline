import { classifyModelFailure, redactModelFailure } from './model-failure.ts';

/** Pi runtime errors only: never extract prompt, response, reasoning, or agent history. */
export interface PiFailure {
  readonly message: string;
  readonly status: number | null;
  readonly scope: 'file' | 'run';
  readonly retryable: boolean;
}

export function readPiFailure(stdout: string, fallback?: string, credential?: string, callerManaged = false): PiFailure | undefined {
  let message: string | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (event === null || typeof event !== 'object') continue;
    const frame = event as Record<string, unknown>;
    if (frame['type'] === 'turn_start') message = undefined;
    if (frame['type'] !== 'turn_end' && frame['type'] !== 'message_end') continue;
    const value = frame['message'];
    if (value === null || typeof value !== 'object') continue;
    const assistant = value as Record<string, unknown>;
    if (assistant['role'] !== 'assistant') continue;
    message = assistant['stopReason'] === 'error' && typeof assistant['errorMessage'] === 'string'
      ? assistant['errorMessage'] : undefined;
  }
  if (message === undefined || message.trim() === '') message = fallback;
  if (message === undefined || message.trim() === '') return undefined;
  // Redact before classification, control filtering, truncation, and JSON escaping.
  message = redactModelFailure(message, credential);
  return { message, ...classifyModelFailure(message, callerManaged) };
}

/** Valid JSON under the existing 500-character persisted-reason bound. */
export function piFailureDiagnostic(failure: PiFailure): string {
  let message = failure.message.slice(0, 300);
  const encode = () => JSON.stringify({ schema: 'pi-error/v1', status: failure.status,
    scope: failure.scope, retryable: failure.retryable, message });
  while (encode().length > 500) message = message.slice(0, Math.max(0, message.length - 16));
  return encode();
}
