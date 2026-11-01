import type { HarnessName, HarnessPrompt, HarnessRun, HarnessSettings, HarnessStreamMode } from '../harness-executor/types.ts';
import { redactCredentialText } from '../harness-executor/model-failure.ts';
import { MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../harness-executor/output-budget.ts';
import { MAX_DIAGNOSTIC_BYTES, MAX_INPUT_BYTES } from '../process-runner.ts';

export const PROTOCOL = 'redline-worker/v1';
export const LIMITS = Object.freeze({
  chunkBytes: 64 * 1024, payloadBytes: 8 * 1024 * 1024, promptBytes: MAX_INPUT_BYTES,
  outputBytes: 64 * 1024 * 1024, diagnosticBytes: MAX_DIAGNOSTIC_BYTES,
  headerBytes: 8 * 1024, frameTimeoutMs: 10_000,
});
export type WorkerHarness = Exclude<HarnessName, 'echo'>;
export type Accept = 'application/json' | 'text/event-stream' | '*/*';
export interface Identity {
  readonly harness: WorkerHarness;
  readonly release: string;
  readonly revision: string;
  readonly harnessVersion: string;
}
interface Envelope { readonly protocol: typeof PROTOCOL; readonly jobId: string }
export interface Invocation extends Envelope {
  readonly kind: 'invoke';
  readonly harness: WorkerHarness;
  readonly model: { readonly provider: string; readonly model: string };
  readonly timeoutMs: number;
  readonly retryOwnership: 'caller' | 'executor';
  readonly modelProtocol: 'compatible' | 'openrouter-json';
  readonly maxOutputTokens?: number;
  readonly streamMode?: HarnessStreamMode;
}
export type RunMetadata = Omit<HarnessRun, 'text' | 'diagnostic' | 'harness'> & { readonly harness: WorkerHarness };
export type HostMessage = Invocation
  | Envelope & { readonly kind: 'input'; readonly data: string }
  | Envelope & { readonly kind: 'input.end' | 'cancel' }
  | Envelope & { readonly kind: 'response.start'; readonly requestId: number; readonly status: number; readonly headers: Readonly<Record<string, string>> }
  | Envelope & { readonly kind: 'response.data'; readonly requestId: number; readonly data: string }
  | Envelope & { readonly kind: 'response.end'; readonly requestId: number }
  | Envelope & { readonly kind: 'response.error'; readonly requestId: number; readonly code: 'transport' | 'limit' };
export type WorkerMessage = { readonly protocol: typeof PROTOCOL; readonly kind: 'hello'; readonly identity: Identity }
  | Envelope & { readonly kind: 'request.start'; readonly requestId: number; readonly accept: Accept }
  | Envelope & { readonly kind: 'request.data'; readonly requestId: number; readonly data: string }
  | Envelope & { readonly kind: 'request.end'; readonly requestId: number }
  | Envelope & { readonly kind: 'output'; readonly stream: 'text' | 'diagnostic'; readonly data: string }
  | Envelope & { readonly kind: 'tap'; readonly stream: 'stdout' | 'stderr'; readonly tapKind: 'line' | 'text'; readonly data: string }
  | Envelope & { readonly kind: 'result'; readonly run: RunMetadata };
export class WorkerFault extends Error {
  constructor(message = 'Invalid worker message') { super(message); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
}
function string(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;
}
function choice(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= min && value <= max;
}
export function jobIdValid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
}
export function identityValid(value: unknown): value is Identity {
  return record(value) && keys(value, ['harness', 'release', 'revision', 'harnessVersion'])
    && (value.harness === 'pi' || value.harness === 'opencode')
    && string(value.release, 64) && string(value.harnessVersion, 64)
    && typeof value.revision === 'string' && /^[a-f0-9]{40}$/u.test(value.revision);
}
export function decodeData(value: unknown): Buffer {
  if (!string(value, Math.ceil(LIMITS.chunkBytes / 3) * 4)) throw new WorkerFault();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > LIMITS.chunkBytes || bytes.toString('base64') !== value) throw new WorkerFault();
  return bytes;
}
function dataValid(value: unknown): boolean {
  try { decodeData(value); return true; } catch { return false; }
}
function headersValid(value: unknown): boolean {
  return record(value) && Object.keys(value).length <= 32 && Buffer.byteLength(JSON.stringify(value)) <= LIMITS.headerBytes
    && Object.entries(value).every(([k, v]) => /^[a-z][a-z0-9-]{0,63}$/u.test(k) && typeof v === 'string' && !/[\r\n\u0000]/u.test(v));
}
function metadataValid(value: unknown): value is RunMetadata {
  if (!record(value) || !keys(value, ['status', 'harness', 'exitCode', 'durationMs'], ['failureScope', 'retryable', 'telemetry'])) return false;
  if (!choice(value.status, ['succeeded', 'failed', 'timed-out']) || !choice(value.harness, ['pi', 'opencode'])) return false;
  if (value.exitCode !== null && !integer(value.exitCode, -2_147_483_648, 2_147_483_647)) return false;
  if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) return false;
  if (value.failureScope !== undefined && value.failureScope !== 'file' && value.failureScope !== 'run') return false;
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') return false;
  if (value.telemetry === undefined) return true;
  const t = value.telemetry;
  const nullable = ['processStartupMs', 'timeToFirstTextMs'];
  const counters = ['stdoutBytes', 'stderrBytes'];
  if (!record(t) || !keys(t, [...nullable, ...counters, 'stdoutTruncated', 'stderrTruncated'], ['usage', 'retryCount'])) return false;
  if (!nullable.every(k => t[k] === null || (typeof t[k] === 'number' && Number.isFinite(t[k]) && t[k] >= 0))
    || !counters.every(k => integer(t[k], 0, Number.MAX_SAFE_INTEGER))
    || typeof t.stdoutTruncated !== 'boolean' || typeof t.stderrTruncated !== 'boolean'
    || (t.retryCount !== undefined && !integer(t.retryCount, 0, Number.MAX_SAFE_INTEGER))) return false;
  if (t.usage === undefined) return true;
  const usage = t.usage;
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd'];
  return record(usage) && keys(usage, fields) && fields.every(k => usage[k] === null
    || (typeof usage[k] === 'number' && Number.isFinite(usage[k]) && usage[k] >= 0));
}
function hostValid(v: unknown): v is HostMessage {
  if (!record(v) || v.protocol !== PROTOCOL || !jobIdValid(v.jobId)) return false;
  const base = ['protocol', 'jobId', 'kind'];
  switch (v.kind) {
    case 'invoke': return keys(v, [...base, 'harness', 'model', 'timeoutMs', 'retryOwnership', 'modelProtocol'], ['maxOutputTokens', 'streamMode'])
      && (v.harness === 'pi' || v.harness === 'opencode') && record(v.model) && keys(v.model, ['provider', 'model'])
      && string(v.model.provider, 256) && string(v.model.model, 1024) && integer(v.timeoutMs, 1, 2_147_483_647)
      && choice(v.retryOwnership, ['caller', 'executor']) && choice(v.modelProtocol, ['compatible', 'openrouter-json'])
      && (v.modelProtocol !== 'openrouter-json' || (v.harness === 'pi' && v.model.provider === 'openrouter'))
      && (v.maxOutputTokens === undefined || integer(v.maxOutputTokens, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS))
      && (v.streamMode === undefined || choice(v.streamMode, ['off', 'dots', 'text']));
    case 'input': return keys(v, [...base, 'data']) && dataValid(v.data);
    case 'input.end': case 'cancel': return keys(v, base);
    case 'response.start': return keys(v, [...base, 'requestId', 'status', 'headers']) && integer(v.requestId, 1, 100)
      && integer(v.status, 200, 599) && headersValid(v.headers);
    case 'response.data': return keys(v, [...base, 'requestId', 'data']) && integer(v.requestId, 1, 100) && dataValid(v.data);
    case 'response.end': return keys(v, [...base, 'requestId']) && integer(v.requestId, 1, 100);
    case 'response.error': return keys(v, [...base, 'requestId', 'code']) && integer(v.requestId, 1, 100) && choice(v.code, ['transport', 'limit']);
    default: return false;
  }
}
function workerValid(v: unknown): v is WorkerMessage {
  if (!record(v) || v.protocol !== PROTOCOL) return false;
  if (v.kind === 'hello') return keys(v, ['protocol', 'kind', 'identity']) && identityValid(v.identity);
  if (!jobIdValid(v.jobId)) return false;
  const base = ['protocol', 'jobId', 'kind'];
  switch (v.kind) {
    case 'request.start': return keys(v, [...base, 'requestId', 'accept']) && integer(v.requestId, 1, 100) && choice(v.accept, ['application/json', 'text/event-stream', '*/*']);
    case 'request.data': return keys(v, [...base, 'requestId', 'data']) && integer(v.requestId, 1, 100) && dataValid(v.data);
    case 'request.end': return keys(v, [...base, 'requestId']) && integer(v.requestId, 1, 100);
    case 'output': return keys(v, [...base, 'stream', 'data']) && choice(v.stream, ['text', 'diagnostic']) && dataValid(v.data);
    case 'tap': return keys(v, [...base, 'stream', 'tapKind', 'data']) && choice(v.stream, ['stdout', 'stderr']) && choice(v.tapKind, ['line', 'text']) && dataValid(v.data);
    case 'result': return keys(v, [...base, 'run']) && metadataValid(v.run);
    default: return false;
  }
}
export function parseHostMessage(value: unknown): HostMessage {
  if (!hostValid(value)) throw new WorkerFault();
  return value;
}
export function parseWorkerMessage(value: unknown): WorkerMessage {
  if (!workerValid(value)) throw new WorkerFault();
  return value;
}
export function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new WorkerFault(); }
}
function json(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(v => json(v, depth + 1));
  return record(value) && Object.values(value).every(v => json(v, depth + 1));
}
export function readPrompt(bytes: Buffer): HarnessPrompt {
  if (bytes.length > LIMITS.payloadBytes) throw new WorkerFault();
  const v = parseJson(bytes);
  if (!record(v) || !keys(v, ['system', 'user'], ['responseSchema']) || typeof v.system !== 'string' || typeof v.user !== 'string'
    || Buffer.byteLength(v.system) + Buffer.byteLength(v.user) > LIMITS.promptBytes
    || (v.responseSchema !== undefined && (!record(v.responseSchema) || !json(v.responseSchema)))) throw new WorkerFault();
  return { system: v.system, user: v.user, ...(v.responseSchema === undefined ? {} : { responseSchema: v.responseSchema }) };
}
export function* chunks(bytes: Buffer): Generator<string> {
  for (let i = 0; i < bytes.length; i += LIMITS.chunkBytes) yield bytes.subarray(i, i + LIMITS.chunkBytes).toString('base64');
}
export function* invocationMessages(harness: WorkerHarness, jobId: string, settings: HarnessSettings, prompt: HarnessPrompt, streamMode: HarnessStreamMode = 'off'): Generator<HostMessage> {
  const payload = Buffer.from(JSON.stringify({ system: prompt.system, user: prompt.user,
    ...(prompt.responseSchema === undefined ? {} : { responseSchema: prompt.responseSchema }) }));
  readPrompt(payload);
  if (redactCredentialText(payload.toString(), settings.credential?.value) !== payload.toString()) {
    throw new WorkerFault('Worker input contains a selected credential');
  }
  // Never spread host settings. The endpoint, credential and scratch path stay on the host.
  const invocation = parseHostMessage({ protocol: PROTOCOL, kind: 'invoke', jobId, harness,
    model: { provider: settings.model.provider, model: settings.model.model }, timeoutMs: settings.timeoutMs,
    retryOwnership: settings.retryOwnership ?? 'executor', modelProtocol: settings.modelProtocol ?? 'compatible',
    ...(settings.maxOutputTokens === undefined ? {} : { maxOutputTokens: settings.maxOutputTokens }),
    ...(streamMode === 'off' ? {} : { streamMode }) });
  const metadata = JSON.stringify(invocation);
  if (redactCredentialText(metadata, settings.credential?.value) !== metadata) throw new WorkerFault('Worker input contains a selected credential');
  yield invocation;
  for (const data of chunks(payload)) yield { protocol: PROTOCOL, kind: 'input', jobId, data };
  yield { protocol: PROTOCOL, kind: 'input.end', jobId };
}
