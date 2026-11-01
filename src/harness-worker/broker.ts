import { redactCredentialText } from '../harness-executor/model-failure.ts';
import { validateOutputTokens } from '../harness-executor/output-budget.ts';
import { chunks, jobIdValid, LIMITS, parseJson, PROTOCOL, record, WorkerFault, type Accept, type HostMessage } from './contract.ts';
import { CredentialStream } from './redaction.ts';

export interface BrokerPolicy {
  readonly jobId: string;
  readonly model: string;
  /** Full generation URL, constructed by the trusted adapter, never supplied by a worker. */
  readonly url: string;
  readonly credential: string | undefined;
  readonly timeoutMs: number;
  /** Derived by the caller from its pinned executor's native retry policy, not Redline retry rounds. */
  readonly maxRequests: number;
  readonly maxOutputTokens?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}
class BrokerLimit extends Error {}
export class ModelBroker {
  readonly jobId: string;
  readonly model: string;
  readonly #url: URL;
  readonly #credential: string | undefined;
  private readonly maxRequests: number;
  private readonly maxOutputTokens: number | undefined;
  private readonly maxResponseBytes: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly external: AbortSignal | undefined;
  private requests = 0;
  private busy = false;
  private closed = false;
  constructor(policy: BrokerPolicy) {
    try { this.#url = new URL(policy.url); } catch { throw new WorkerFault('Invalid broker policy'); }
    if (!['http:', 'https:'].includes(this.#url.protocol) || this.#url.username || this.#url.password || this.#url.hash
      || !jobIdValid(policy.jobId) || typeof policy.model !== 'string' || !policy.model.length || Buffer.byteLength(policy.model) > 1024
      || !Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 1 || policy.timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(policy.maxRequests) || policy.maxRequests < 1 || policy.maxRequests > 100
      || (policy.credential !== undefined && (typeof policy.credential !== 'string' || !policy.credential.length || Buffer.byteLength(policy.credential) > 16 * 1024))
      || (policy.maxResponseBytes !== undefined && (!Number.isSafeInteger(policy.maxResponseBytes) || policy.maxResponseBytes < 1 || policy.maxResponseBytes > LIMITS.outputBytes))) {
      throw new WorkerFault('Invalid broker policy');
    }
    this.jobId = policy.jobId; this.model = policy.model; this.#credential = policy.credential;
    this.maxRequests = policy.maxRequests;
    this.maxResponseBytes = policy.maxResponseBytes ?? LIMITS.outputBytes;
    this.maxOutputTokens = policy.maxOutputTokens === undefined ? undefined : validateOutputTokens(policy.maxOutputTokens);
    this.timer = setTimeout(() => this.close(), policy.timeoutMs);
    this.external = policy.signal;
    this.external?.addEventListener('abort', this.close, { once: true });
    if (this.external?.aborted) this.close();
  }
  get signal(): AbortSignal { return this.controller.signal; }
  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.close);
    this.controller.abort();
  };
  /** Diagnostics may serialize metadata, never the policy, credential or live handles. */
  toJSON(): { jobId: string; model: string } { return { jobId: this.jobId, model: this.model }; }
  redact(text: string): string { return redactCredentialText(text, this.#credential); }
  private authorize(body: Buffer): void {
    if (this.closed || this.busy || this.requests >= this.maxRequests || body.length > LIMITS.payloadBytes) throw new WorkerFault('Broker access denied');
    const value = parseJson(body);
    if (!record(value) || value.model !== this.model || (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length !== 0))
      || (value.functions !== undefined && (!Array.isArray(value.functions) || value.functions.length !== 0))
      || (value.tool_choice !== undefined && value.tool_choice !== 'none' && value.tool_choice !== 'auto')
      || (value.function_call !== undefined && value.function_call !== 'none')) throw new WorkerFault('Broker access denied');
    if (this.maxOutputTokens !== undefined) {
      const cap = value.max_completion_tokens ?? value.max_tokens;
      if (!Number.isSafeInteger(cap) || typeof cap !== 'number' || cap < 1 || cap > this.maxOutputTokens) throw new WorkerFault('Broker access denied');
    }
  }
  async *request(requestId: number, body: Buffer, accept: Accept): AsyncGenerator<HostMessage> {
    this.authorize(body);
    if (requestId !== this.requests + 1 || !['application/json', 'text/event-stream', '*/*'].includes(accept)) throw new WorkerFault('Broker access denied');
    this.requests++; this.busy = true;
    const base = { protocol: PROTOCOL, jobId: this.jobId, requestId } as const;
    const requestController = new AbortController();
    try {
      const response = await fetch(this.#url, {
        method: 'POST', body: new Uint8Array(body), redirect: 'manual', signal: AbortSignal.any([this.signal, requestController.signal]),
        headers: { 'content-type': 'application/json', accept, 'accept-encoding': 'identity',
          ...(this.#credential === undefined ? {} : { authorization: 'Bearer ' + this.#credential }) },
      });
      const headers: Record<string, string> = {};
      for (const [name, value] of response.headers) {
        if (/^(?:content-type|retry-after|retry-after-ms|x-request-id|x-ratelimit-[a-z-]+|openai-processing-ms)$/u.test(name)) {
          headers[name] = this.redact(value);
        }
      }
      if (Buffer.byteLength(JSON.stringify(headers)) > LIMITS.headerBytes || Object.keys(headers).length > 32) {
        await response.body?.cancel(); throw new BrokerLimit();
      }
      yield { ...base, kind: 'response.start', status: response.status, headers };
      const redactor = new CredentialStream(this.#credential);
      let bytes = 0;
      if (response.body !== null) {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > this.maxResponseBytes) throw new BrokerLimit();
          for (const data of chunks(redactor.push(chunk))) yield { ...base, kind: 'response.data', data };
        }
      }
      for (const data of chunks(redactor.push(new Uint8Array(), true))) yield { ...base, kind: 'response.data', data };
      yield { ...base, kind: 'response.end' };
    } catch (error) {
      // Raw fetch errors and upstream bodies can contain URL/authentication details.
      yield { ...base, kind: 'response.error', code: error instanceof BrokerLimit ? 'limit' : 'transport' };
    } finally { requestController.abort(); this.busy = false; }
  }
}
