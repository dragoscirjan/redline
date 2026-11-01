import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { CODES, LIMITS, VERSION, RpcFault, fault, object, params, valid, type Id, type WireError } from './contract.ts';
import type { ReviewEvent } from '../application/review.ts';
import type { Artifacts, Completion, Execute, RunState, Section, Sections } from './local.ts';

interface Job {
  readonly id: string;
  readonly controller: AbortController;
  state: RunState; exitCode: number | null; error: WireError | null;
  artifacts: Artifacts | null; sections: Sections | undefined; bytes: number;
  task: Promise<void>; sequence: number;
  readonly required: Set<string>; readonly completed: Set<string>; readonly activeFiles: Set<string>;
  pending: Record<string, unknown> | undefined; timer: NodeJS.Timeout | undefined;
}
export interface SessionOptions {
  readonly execute: Execute;
  readonly send: (value: unknown, optional?: boolean) => boolean;
  readonly once: boolean;
}
const terminal = (job: Job) => job.state !== 'running';
const descriptor = (job: Job) => ({
  runId: job.id, state: job.state, exitCode: job.exitCode, error: job.error,
  artifacts: job.artifacts, resultAvailable: job.sections !== undefined,
  progress: { requiredFiles: job.required.size, settledFiles: job.completed.size, activeFiles: job.activeFiles.size },
});
const METHODS = new Map([
  ['redline/v1/initialize', 'initialize'], ['redline/v1/review.start', 'start'],
  ['redline/v1/review.get', 'get'], ['redline/v1/review.cancel', 'cancel'],
  ['redline/v1/review.result', 'result'], ['redline/v1/shutdown', 'shutdown'],
]);
export class Session {
  private readonly options: SessionOptions;
  private initialized = false;
  private started = false;
  private progressEnabled = true;
  private readonly jobs = new Map<string, Job>();
  private active: Job | undefined;
  private retainedBytes = 0;
  private stopping = false;
  constructor(options: SessionOptions) { this.options = options; }
  get closing(): boolean { return this.stopping; }
  private send(value: unknown, optional = false): void {
    const schema = object(value) && 'id' in value ? ('error' in value ? 'errorResponse' : 'successResponse') : 'serverNotification';
    if (!valid(schema, value)) throw new RpcFault(CODES.internal, 'Response failed schema validation');
    if (!this.options.send(value, optional) && !optional) this.stop();
  }
  /** JSON parse errors belong to transport; valid JSON with invalid envelopes belongs here. */
  receive(input: unknown): void {
    if (Array.isArray(input)) {
      if (input.length === 0 || input.length > LIMITS.batchSize) { this.error(null, CODES.request, 'Invalid batch'); return; }
      // Process batch side effects in array order. Suppress notification replies.
      const ids = input.filter(object).filter(value => valid('id', value.id)).map(value => typeof value.id + ':' + String(value.id));
      if (new Set(ids).size !== ids.length) { this.error(null, CODES.request, 'Duplicate batch IDs'); return; }
      const replies: unknown[] = [];
      for (const value of input) {
        const reply = this.request(value);
        if (reply !== undefined) replies.push(reply);
      }
      const sizes = replies.map(reply => Buffer.byteLength(JSON.stringify(reply)));
      let bytes = 2 + Math.max(0, replies.length - 1) + sizes.reduce((sum, size) => sum + size, 0);
      // Bound large data replies without discarding acknowledgements of operations already run.
      const largest = sizes.map((size, index) => ({ size, index })).sort((a, b) => b.size - a.size);
      for (const { size, index } of largest) {
        if (bytes <= LIMITS.messageBytes) break;
        const reply = replies[index];
        const limited = { jsonrpc: '2.0', id: object(reply) ? reply.id : null,
          error: { code: CODES.limit, message: 'Batch result exceeds limit; query this result individually' } };
        replies[index] = limited;
        bytes += Buffer.byteLength(JSON.stringify(limited)) - size;
      }
      if (replies.length > 0 && !this.options.send(replies)) this.stop();
      return;
    }
    const reply = this.request(input);
    if (reply !== undefined) this.send(reply);
  }
  error(id: Id | null, code: number, message: string): void { this.send({ jsonrpc: '2.0', id, error: { code, message } }); }
  private request(input: unknown): unknown {
    if (!valid('request', input) && !valid('notification', input)) return { jsonrpc: '2.0', id: null, error: { code: CODES.request, message: 'Invalid Request' } };
    if (!object(input)) return undefined;
    const id = input.id as Id | undefined;
    if (id === undefined) {
      if (input.method === 'redline/v1/exit' && valid('exitParams', input.params ?? {})) this.stop();
      return undefined;
    }
    try {
      if (this.stopping) throw new RpcFault(CODES.initialize, 'Session is shutting down');
      const method = typeof input.method === 'string' ? METHODS.get(input.method) : undefined;
      if (method === undefined) throw new RpcFault(CODES.method, 'Method not found');
      const value = params(method, input.params ?? {});
      if (method === 'initialize') {
        if (this.initialized) throw new RpcFault(CODES.initialize, 'Session already initialized');
        if (String(value.protocolVersion).split('.')[0] !== '1') throw new RpcFault(CODES.version, 'Unsupported protocol version');
        this.initialized = true;
        const requested = value.optionalCapabilities;
        this.progressEnabled = requested === undefined || (Array.isArray(requested) && requested.includes('progress'));
        return this.success(id, { protocolVersion: VERSION, capabilities: ['git', 'cancel', 'artifacts', 'pagination', 'batch',
          ...(this.progressEnabled ? ['progress'] : [])], limits: LIMITS });
      }
      if (!this.initialized) throw new RpcFault(CODES.initialize, 'Initialize the session first');
      if (method === 'shutdown') { this.stop(); return this.success(id, { accepted: true }); }
      if (method === 'start') return this.success(id, this.start(value));
      const job = this.jobs.get(String(value.runId));
      if (job === undefined) throw new RpcFault(CODES.missing, 'Run not found or evicted');
      if (method === 'cancel') { if (!terminal(job)) job.controller.abort(); return this.success(id, descriptor(job)); }
      if (method === 'get') return this.success(id, descriptor(job));
      return this.success(id, this.page(job, value));
    } catch (error) { return { jsonrpc: '2.0', id, error: fault(error) }; }
  }
  private success(id: Id, result: unknown): unknown {
    const value = { jsonrpc: '2.0', id, result };
    if (!valid('successResponse', value)) throw new RpcFault(CODES.internal, 'Response failed schema validation');
    return value;
  }
  private evict(except?: Job): void {
    for (const [id, job] of this.jobs) {
      if (job !== except && terminal(job)) { this.jobs.delete(id); this.retainedBytes -= job.bytes; return; }
    }
  }
  private start(selection: Record<string, unknown>): unknown {
    if (typeof selection.repository !== 'string' || !isAbsolute(selection.repository)) throw new RpcFault(CODES.params, 'Repository must be an absolute path');
    if (this.active !== undefined) throw new RpcFault(CODES.busy, 'A review is already running');
    if (this.options.once && this.started) throw new RpcFault(CODES.busy, 'One-shot review already started');
    while (this.jobs.size >= LIMITS.historyRuns) this.evict();
    const job: Job = { id: randomUUID(), controller: new AbortController(), state: 'running', exitCode: null, error: null,
      artifacts: null, sections: undefined, bytes: 0, task: Promise.resolve(), sequence: 0, pending: undefined, timer: undefined,
      required: new Set(), completed: new Set(), activeFiles: new Set() };
    this.started = true; this.active = job; this.jobs.set(job.id, job);
    job.task = Promise.resolve().then(async () => {
      try {
        const result = await this.options.execute(selection, job.controller.signal, {
          progress: event => this.progress(job, event), artifacts: value => {
            if (!valid('artifacts', value)) throw new RpcFault(CODES.internal, 'Invalid artifact references');
            job.artifacts = value;
            this.send({ jsonrpc: '2.0', method: 'redline/v1/artifacts', params: { run: descriptor(job) } });
          },
        });
        this.finish(job, result);
      } catch (error) {
        this.finish(job, { state: job.controller.signal.aborted ? 'cancelled' : 'failed', exitCode: job.controller.signal.aborted ? 130 : 1,
          error: job.controller.signal.aborted ? { code: CODES.cancellation, message: 'Review cancelled' } : fault(error) });
      }
    }).catch(() => this.stop());
    return descriptor(job);
  }
  private progress(job: Job, event: ReviewEvent): void {
    if (terminal(job)) return;
    if (event.kind === 'planned') for (const file of event.files) if (file.reviewed) job.required.add(file.fileId);
    if (event.kind === 'file-started') { job.activeFiles.add(event.fileId); job.completed.delete(event.fileId); }
    if (event.kind === 'file-completed') { job.activeFiles.delete(event.fileId); if (job.required.has(event.fileId)) job.completed.add(event.fileId); }
    if (!this.progressEnabled || this.stopping) return;
    // Explicit metadata projection. Never copy arbitrary event fields or source paths.
    const value: Record<string, unknown> = { kind: event.kind };
    if (event.kind === 'planned') value.files = event.files.length;
    if (event.kind === 'workload') { value.files = event.files; value.workers = event.workers; }
    if (event.kind === 'file-started' || event.kind === 'file-retry' || event.kind === 'file-completed') value.fileId = event.fileId;
    if (event.kind === 'file-retry') { value.attempt = event.attempt; value.maximumAttempts = event.maximumAttempts; value.timeoutMs = event.timeoutMs; }
    if (event.kind === 'file-completed') value.outcome = event.outcome;
    if (event.kind === 'context-ready') { value.status = event.status; value.relatedSpans = event.relatedSpans; value.fileOnlyFiles = event.fileOnlyFiles; }
    value.requiredFiles = job.required.size; value.settledFiles = job.completed.size; value.activeFiles = job.activeFiles.size;
    job.pending = value;
    if (job.timer === undefined) job.timer = setTimeout(() => this.flushProgress(job), 100);
  }
  private flushProgress(job: Job): void {
    if (job.timer !== undefined) clearTimeout(job.timer); job.timer = undefined;
    if (job.pending !== undefined && !this.stopping) this.send({ jsonrpc: '2.0', method: 'redline/v1/progress',
      params: { runId: job.id, sequence: ++job.sequence, event: job.pending } }, true);
    job.pending = undefined;
  }
  private finish(job: Job, result: Completion): void {
    if (terminal(job)) return;
    this.flushProgress(job);
    job.state = result.state; job.exitCode = result.exitCode; job.error = result.error;
    job.activeFiles.clear();
    if (result.sections !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(result.sections));
      if (bytes <= LIMITS.retainedBytes / 2) {
        while (this.retainedBytes + bytes > LIMITS.retainedBytes) this.evict(job);
        job.sections = result.sections; job.bytes = bytes; this.retainedBytes += bytes;
      }
    }
    this.active = undefined;
    this.send({ jsonrpc: '2.0', method: 'redline/v1/finished', params: { run: descriptor(job) } });
  }
  private page(job: Job, input: Record<string, unknown>): unknown {
    if (!terminal(job)) throw new RpcFault(CODES.busy, 'Review is still running');
    if (job.sections === undefined) throw new RpcFault(CODES.limit, 'Result unavailable over RPC; use artifact references');
    const section = String(input.section ?? 'overview') as Section;
    const all = job.sections[section];
    const offset = Number(input.offset ?? 0);
    const limit = Number(input.limit ?? 20);
    if (offset > all.length) throw new RpcFault(CODES.params, 'Offset exceeds result length');
    const items = all.slice(offset, offset + limit);
    const page = () => ({ runId: job.id, section, total: all.length, nextOffset: offset + items.length < all.length ? offset + items.length : null, items });
    while (Buffer.byteLength(JSON.stringify(page())) > LIMITS.messageBytes - 1024 && items.length > 0) items.pop();
    if (items.length === 0 && offset < all.length) throw new RpcFault(CODES.limit, 'Result item exceeds message limit; use artifact references');
    return page();
  }
  stop(): void { this.stopping = true; this.active?.controller.abort(); }
  async end(): Promise<void> {
    if (!this.options.once) this.stop();
    const task = this.active?.task;
    if (task !== undefined) await task;
    this.stopping = true;
  }
}
