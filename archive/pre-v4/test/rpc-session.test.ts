import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/rpc/session.ts';
import { serve } from '../src/rpc/server.ts';
import { CODES, LIMITS, object } from '../src/rpc/contract.ts';
import { frame, FrameReader } from '../src/rpc/framing.ts';
import type { Completion, Execute, ExecutionCallbacks } from '../src/rpc/local.ts';
const done: Completion = { state: 'completed', exitCode: 0, error: null, sections: { overview: [{
  verdict: 'mergeable', coverage: { status: 'completed', requiredFiles: 0, completedFiles: 0, omittedFiles: 0, excludedFiles: 0, contextStatus: 'disabled' }, findings: 0, limitations: [],
}], files: [], findings: [] } };
interface Snapshot {
  readonly raw: unknown; readonly id: unknown; readonly method: unknown;
  readonly result: Record<string, unknown>; readonly error: Record<string, unknown>; readonly params: Record<string, unknown>;
  readonly batch: readonly Snapshot[];
}
function snapshot(raw: unknown): Snapshot {
  const value = object(raw) ? raw : {};
  return { raw, id: value.id, method: value.method, result: object(value.result) ? value.result : {},
    error: object(value.error) ? value.error : {}, params: object(value.params) ? value.params : {},
    batch: Array.isArray(raw) ? raw.map(snapshot) : [] };
}
function harness(execute: Execute = async () => done, once = false) {
  const sent: Snapshot[] = [];
  const session = new Session({ execute, once, send: value => { sent.push(snapshot(value)); return true; } });
  let id = 0;
  const call = (method: string, params: unknown = {}) => { session.receive({ jsonrpc: '2.0', id: id++, method: 'redline/v1/' + method, params }); const value = sent.at(-1); if (value === undefined) throw new Error('Missing response'); return value; };
  return { session, sent, call, init: () => call('initialize', { protocolVersion: '1.0' }) };
}

describe('RPC session state', () => {
  it('negotiates versions and optional capabilities without starting work', async () => {
    const execute = vi.fn(async () => done); const h = harness(execute);
    expect(h.call('review.start', { repository: '/repo' }).error.code).toBe(CODES.initialize);
    expect(h.call('initialize', { protocolVersion: '2.0' }).error.code).toBe(CODES.version);
    const init = h.call('initialize', { protocolVersion: '1.9', optionalCapabilities: ['unknown-future'] });
    expect(init.result.protocolVersion).toBe('1.0'); expect(init.result.capabilities).not.toContain('unknown-future');
    expect(h.init().error.code).toBe(CODES.initialize);
    expect(h.call('unknown').error.code).toBe(CODES.method);
    expect(execute).not.toHaveBeenCalled(); await h.session.end();
  });
  it('supports batches, ID zero, unknown notifications, malformed input and duplicate-batch rejection', async () => {
    const h = harness(); h.init(); h.sent.length = 0;
    h.session.receive({ jsonrpc: '2.0', method: 'unknown' }); expect(h.sent).toEqual([]);
    h.session.receive([{ jsonrpc: '2.0', id: 0, method: 'unknown' }, false, { jsonrpc: '2.0', method: 'unknown' }]);
    expect(h.sent[0]?.batch).toHaveLength(2); expect(h.sent[0]?.batch[0]?.id).toBe(0); expect(h.sent[0]?.batch[1]?.id).toBe(null);
    h.session.receive({ jsonrpc: '2.0', id: 7, method: 'redline/v1/review.get', params: [] });
    expect(h.sent.at(-1)?.error.code).toBe(CODES.params);
    h.session.receive([{ jsonrpc: '2.0', id: { toString: 'not-callable' }, method: 'unknown' }]);
    expect(h.sent.at(-1)?.batch[0]?.error.code).toBe(CODES.request);
    h.session.receive([]); expect(h.sent.at(-1)?.error.code).toBe(CODES.request);
    h.session.receive(Array(17).fill({})); expect(h.sent.at(-1)?.error.code).toBe(CODES.request);
    h.session.receive([{ jsonrpc: '2.0', id: 1, method: 'unknown' }, { jsonrpc: '2.0', id: 1, method: 'unknown' }]);
    expect(h.sent.at(-1)?.error.message).toBe('Duplicate batch IDs'); await h.session.end();
  });
  it.each([false, true])('runs, queries, pages and finishes in once=%s mode', async once => {
    const h = harness(async () => done, once); h.init();
    const start = h.call('review.start', { repository: '/repo' }).result;
    expect(h.call('review.start', { repository: '/repo' }).error.code).toBe(CODES.busy);
    expect(h.call('review.result', { runId: start.runId }).error.code).toBe(CODES.busy);
    await new Promise(resolve => setImmediate(resolve));
    expect(h.call('review.get', { runId: start.runId }).result.state).toBe('completed');
    expect(h.call('review.result', { runId: start.runId }).result.items).toMatchObject([{ verdict: 'mergeable' }]);
    expect(h.call('review.result', { runId: start.runId, offset: 2 }).error.code).toBe(CODES.params);
    expect(h.call('review.cancel', { runId: start.runId }).result.state).toBe('completed');
    expect(h.sent.filter(v => v.method === 'redline/v1/finished')).toHaveLength(1);
    if (once) expect(h.call('review.start', { repository: '/repo' }).error.code).toBe(CODES.busy);
    await h.session.end();
  });
  it.each(['review.start', 'review.cancel', 'shutdown'])('preserves %s acknowledgements when batch result pages exceed the wire limit', async method => {
    const overview = done.sections?.overview[0];
    if (overview === undefined) throw new Error('Missing overview fixture');
    const large: Completion = { ...done, sections: { overview: [{ ...overview, limitations: [
      { code: 'fixture-a', required: false, message: 'x'.repeat(400_000) },
      { code: 'fixture-b', required: false, message: 'y'.repeat(400_000) },
    ] }], files: [], findings: [] } };
    let executions = 0;
    const h = harness(async (_selection, signal) => {
      if (++executions === 1) return large;
      if (method === 'review.cancel') {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { state: 'cancelled', exitCode: 130, error: null };
      }
      return done;
    }); h.init();
    const previous = h.call('review.start', { repository: '/repo' }).result;
    await new Promise(resolve => setImmediate(resolve));
    let parameters: Record<string, unknown> = method === 'review.start' ? { repository: '/repo' } : {};
    if (method === 'review.cancel') {
      const active = h.call('review.start', { repository: '/repo' }).result;
      parameters = { runId: active.runId }; await new Promise(resolve => setImmediate(resolve));
    }
    h.sent.length = 0;
    const page = (id: string) => ({ jsonrpc: '2.0', id, method: 'redline/v1/review.result', params: { runId: previous.runId } });
    h.session.receive([page('page-a'), page('page-b'), { jsonrpc: '2.0', id: 'operation', method: 'redline/v1/' + method, params: parameters }]);
    const batch = h.sent.find(value => value.batch.length > 0);
    expect(batch?.batch).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(batch?.raw))).toBeLessThanOrEqual(LIMITS.messageBytes);
    expect(batch?.batch.find(value => value.id === 'operation')?.result).toMatchObject(method === 'shutdown' ? { accepted: true } : { state: 'running' });
    const pages = batch?.batch.filter(value => value.id !== 'operation') ?? [];
    expect(pages.filter(value => value.error.code === CODES.limit)).toHaveLength(1);
    expect(pages.filter(value => Array.isArray(value.result.items))).toHaveLength(1);
    await h.session.end();
  });
  it('cancels active work cooperatively and emits exactly one terminal notification', async () => {
    const h = harness(async (_selection, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ state: 'cancelled', exitCode: 130, error: { code: CODES.cancellation, message: 'Review cancelled' } }), { once: true });
    })); h.init();
    const job = h.call('review.start', { repository: '/repo' }).result; await new Promise(resolve => setImmediate(resolve));
    h.call('review.cancel', { runId: job.runId }); await h.session.end();
    expect(h.sent.filter(v => v.method === 'redline/v1/finished')).toHaveLength(1);
    expect(h.call('review.get', { runId: job.runId }).error.code).toBe(CODES.initialize);
    expect(h.sent.find(v => v.method === 'redline/v1/finished')?.params.run).toMatchObject({ state: 'cancelled' });
  });
  it('preserves the engine outcome when completion wins a cancellation race', async () => {
    let settle!: (value: Completion) => void;
    const h = harness(async () => new Promise<Completion>(resolve => { settle = resolve; })); h.init();
    const job = h.call('review.start', { repository: '/repo' }).result;
    await new Promise(resolve => setImmediate(resolve));
    expect(h.call('review.cancel', { runId: job.runId }).result.state).toBe('running');
    settle(done); await new Promise(resolve => setImmediate(resolve));
    expect(h.call('review.get', { runId: job.runId }).result).toMatchObject({ state: 'completed', exitCode: 0, error: null });
    expect(h.sent.filter(value => value.method === 'redline/v1/finished')).toHaveLength(1);
    await h.session.end();
  });
  it('bounds terminal history and safely reports evicted IDs', async () => {
    const h = harness(); h.init(); const ids: string[] = [];
    for (let i = 0; i < LIMITS.historyRuns + 1; i++) {
      ids.push(String(h.call('review.start', { repository: '/repo' }).result.runId));
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(h.call('review.get', { runId: ids[0] }).error.code).toBe(CODES.missing);
    expect(h.call('review.get', { runId: ids.at(-1) }).result.state).toBe('completed'); await h.session.end();
  });
  it('projects progress metadata without raw fields and stops progress after completion', async () => {
    let callbacks: ExecutionCallbacks | undefined;
    const h = harness(async (_selection, _signal, events) => {
      callbacks = events;
      events.progress({ kind: 'planned', files: [{ fileId: '1', reviewed: true }] });
      events.progress({ kind: 'file-completed', fileId: '1', outcome: 'clean', source: 'SECRET_SOURCE' } as never);
      return done;
    }); h.init(); h.call('review.start', { repository: '/repo' });
    await new Promise(resolve => setImmediate(resolve));
    const count = h.sent.length; callbacks?.progress({ kind: 'started' });
    expect(h.sent).toHaveLength(count); expect(JSON.stringify(h.sent)).not.toContain('SECRET_SOURCE');
    expect(h.sent.find(v => v.method === 'redline/v1/progress')?.params.event).toEqual({ kind: 'file-completed', fileId: '1', outcome: 'clean', requiredFiles: 1, settledFiles: 1, activeFiles: 0 });
    await h.session.end();
  });
  it.each(['file-retry', 'context-started'])('drops credential-bearing free text from %s progress', async kind => {
    const credential = 'SYNTHETIC_PROGRESS_CREDENTIAL';
    const h = harness(async (_selection, _signal, events) => {
      events.progress(kind === 'file-retry'
        ? { kind, fileId: '000001', attempt: 2, maximumAttempts: 4, timeoutMs: 60_000, reason: credential }
        : { kind: 'context-started', provider: credential });
      return done;
    }); h.init(); h.call('review.start', { repository: '/repo' });
    await new Promise(resolve => setImmediate(resolve));
    expect(h.sent.find(value => value.method === 'redline/v1/progress')?.params.event).toMatchObject({ kind });
    expect(JSON.stringify(h.sent)).not.toContain(credential);
    await h.session.end();
  });
  it('does not echo thrown input or credential text into diagnostics', async () => {
    const h = harness(async () => { throw new Error('SECRET_PROVIDER_KEY'); }); h.init(); h.call('review.start', { repository: '/repo' });
    await new Promise(resolve => setImmediate(resolve));
    expect(JSON.stringify(h.sent)).not.toContain('SECRET_PROVIDER_KEY');
    expect(h.sent.at(-1)?.params.run).toMatchObject({ error: { code: CODES.internal } }); await h.session.end();
  });
});

describe('RPC stream failures', () => {
  it('recovers from a framed JSON parse error without echoing its content', async () => {
    const input = new PassThrough(); const chunks: Buffer[] = [];
    const output = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const running = serve({ input, output, once: true, execute: async () => done });
    input.end(Buffer.concat([Buffer.from('Content-Length: 6\r\n\r\nsecret'), frame({ jsonrpc: '2.0', id: 0, method: 'redline/v1/initialize', params: { protocolVersion: '1.0' } })]));
    expect(await running).toBe(0);
    const responses = new FrameReader().push(Buffer.concat(chunks)).map(v => JSON.parse(v.toString()));
    expect(responses[0].error.code).toBe(CODES.parse); expect(responses[1].id).toBe(0);
    expect(Buffer.concat(chunks).toString()).not.toContain('secret');
  });
  it('rejects truncated frames and partial-frame stalls within a fixed deadline', async () => {
    vi.useFakeTimers();
    const input = new PassThrough(); const output = new Writable({ write(_c, _e, done) { done(); } });
    const running = serve({ input, output, execute: async () => done });
    input.write('Content-Length: 100\r\n\r\n{');
    await vi.advanceTimersByTimeAsync(LIMITS.frameTimeoutMs + 1);
    expect(await running).toBe(1); vi.useRealTimers();
  });
  it('cancels persistent work on EOF but drains one-shot work', async () => {
    for (const once of [false, true]) {
      let aborted = false;
      const input = new PassThrough(); const output = new Writable({ write(_c, _e, done) { done(); } });
      const running = serve({ input, output, once, execute: async (_s, signal) => {
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 20); signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); resolve(); }, { once: true }); });
        return aborted ? { state: 'cancelled', exitCode: 130, error: null } : done;
      } });
      input.end(Buffer.concat([frame({ jsonrpc: '2.0', id: 1, method: 'redline/v1/initialize', params: { protocolVersion: '1.0' } }),
        frame({ jsonrpc: '2.0', id: 2, method: 'redline/v1/review.start', params: { repository: '/repo' } })]));
      expect(await running).toBe(0); expect(aborted).toBe(!once);
    }
  });
});
