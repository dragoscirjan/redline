import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelBroker } from '../src/harness-worker/broker.ts';
import { runWorkerJob } from '../src/harness-worker/host.ts';
import { frame, FrameReader } from '../src/transport/framing.ts';
import { PROTOCOL, LIMITS, WorkerFault, parseHostMessage, parseJson, type Identity } from '../src/harness-worker/contract.ts';

const identity: Identity = { harness: 'pi', release: '1.1.0', revision: 'a'.repeat(40), harnessVersion: '1.4.0-fixture' };
const jobId = '00000000-0000-4000-8000-000000000001';
const key = 'synthetic-host-only-provider-key';
const children: { child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }[] = [];
const servers: Server[] = []; const brokers: ModelBroker[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) b.close();
  await Promise.all(children.splice(0).map(async ({ child, closed }) => { child.kill('SIGKILL'); await closed; }));
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
});
async function fixture() {
  const received: { body: string; auth: string | undefined }[] = [];
  let started: (() => void) | undefined; let disconnected: (() => void) | undefined;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const peerClosed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    received.push({ body, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.on('close', () => disconnected?.());
    res.write('data: ' + JSON.stringify({ text: '雪', reflected: key }) + '\n\n'); started?.();
    if (!body.includes('stream-block')) res.end('data: [DONE]\n\n');
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Fixture port');
  return { received, requestStarted, peerClosed, url: `http://127.0.0.1:${address.port}/chat/completions` };
}
function startProbe() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/worker/probe.ts', import.meta.url))], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); children.push({ child, closed });
  return { child, closed };
}
async function run(mode: string, extra: { timeoutMs?: number; signal?: AbortSignal; identity?: Identity } = {}) {
  const target = await fixture(); const probe = startProbe();
  const timeoutMs = extra.timeoutMs ?? 5000;
  const broker = new ModelBroker({ jobId, model: 'owner/model', url: target.url, credential: key, timeoutMs, maxRequests: 1,
    maxOutputTokens: 4096, ...(extra.signal === undefined ? {} : { signal: extra.signal }) }); brokers.push(broker);
  const result = runWorkerJob({ input: probe.child.stdout, output: probe.child.stdin, identity: extra.identity ?? identity,
    settings: { model: { provider: 'openrouter', endpoint: target.url, model: 'owner/model' }, credential: { provider: 'openrouter', value: key },
      workDirectory: '/private/host-only', timeoutMs, maxOutputTokens: 4096, retryOwnership: 'caller' },
    prompt: { system: 'fixed trusted policy', user: mode }, broker });
  return { result, target, broker, ...probe };
}

describe('real subprocess worker channel', () => {
  it('transfers a model request, streamed bytes and run metadata without passing the real credential or host paths', async () => {
    const job = await run('success');
    const result = await job.result; await job.closed;
    expect(result.status).toBe('succeeded'); expect(result.text).toContain('雪'); expect(result.text).toContain('[redacted]');
    expect(result.telemetry).toMatchObject({ stdoutTruncated: false, timeToFirstTextMs: 0 });
    expect(result.diagnostic).not.toContain(key); expect(result.diagnostic).not.toContain('/private/host-only');
    expect(result.diagnostic).not.toContain(job.target.url); expect(result.diagnostic).toContain('fixed trusted policy');
    expect(job.target.received).toHaveLength(1); expect(job.target.received[0]?.auth).toBe('Bearer ' + key);
    expect(JSON.parse(job.target.received[0]?.body ?? '{}')).toMatchObject({ model: 'owner/model', reasoning: { effort: 'high' }, max_tokens: 4096 });
    expect(job.broker.signal.aborted).toBe(true);
  });
  it.each(['wrong-model', 'wrong-job', 'bad-version'])('rejects hostile probe %s without model side effects', async mode => {
    const job = await run(mode); await expect(job.result).rejects.toBeInstanceOf(WorkerFault); await job.closed;
    expect(job.target.received).toHaveLength(0); expect(job.broker.signal.aborted).toBe(true);
  });
  it('checks the expected build identity before invocation', async () => {
    const job = await run('success', { identity: { ...identity, revision: 'b'.repeat(40) } });
    await expect(job.result).rejects.toThrow(); await job.closed; expect(job.target.received).toHaveLength(0);
  });
  it('terminates a silent worker channel at the job deadline and external cancellation', async () => {
    const expired = await run('hang', { timeoutMs: 100 });
    await expect(expired.result).rejects.toThrow(); await expired.closed;
    const controller = new AbortController(); const cancelled = await run('hang', { signal: controller.signal });
    controller.abort(); await expect(cancelled.result).rejects.toThrow(); await cancelled.closed;
    expect(cancelled.target.received).toHaveLength(0);
  });
  it('cancels a subprocess during upstream streaming and closes both connections', async () => {
    const controller = new AbortController(); const job = await run('stream-block', { signal: controller.signal });
    await job.target.requestStarted; controller.abort();
    await expect(job.result).rejects.toBeInstanceOf(WorkerFault);
    await Promise.all([job.closed, job.target.peerClosed]);
    expect(job.broker.signal.aborted).toBe(true); expect(job.target.received).toHaveLength(1);
  });
  it('rejects a result-less EOF without trusting diagnostic text', async () => {
    const target = await fixture();
    const input = new PassThrough(); const output = new PassThrough();
    const broker = new ModelBroker({ jobId, model: 'owner/model', url: target.url, credential: key, timeoutMs: 500, maxRequests: 1 }); brokers.push(broker);
    const result = runWorkerJob({ input, output, identity, settings: { model: { provider: 'p', endpoint: target.url, model: 'owner/model' },
      credential: undefined, workDirectory: '/private', timeoutMs: 500 }, prompt: { system: 's', user: 'u' }, broker });
    input.end(frame({ protocol: PROTOCOL, kind: 'hello', identity }));
    await expect(result).rejects.toThrow('disconnected'); expect(target.received).toHaveLength(0);
  });
  it.each(['diagnostic', 'duplicate'])('bounds hostile channel %s before upstream effects', async mode => {
    const target = await fixture(); const input = new PassThrough();
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const broker = new ModelBroker({ jobId, model: 'owner/model', url: target.url, credential: key, timeoutMs: 1000, maxRequests: 1 }); brokers.push(broker);
    const result = runWorkerJob({ input, output, identity, settings: { model: { provider: 'p', endpoint: target.url, model: 'owner/model' },
      credential: undefined, workDirectory: '/private', timeoutMs: 1000 }, prompt: { system: 's', user: 'u' }, broker });
    const messages = [frame({ protocol: PROTOCOL, kind: 'hello', identity })];
    if (mode === 'diagnostic') {
      for (let i = 0; i <= LIMITS.diagnosticBytes / LIMITS.chunkBytes; i++) messages.push(frame({ protocol: PROTOCOL, kind: 'output', jobId,
        stream: 'diagnostic', data: Buffer.alloc(LIMITS.chunkBytes, 120).toString('base64') }));
    } else {
      for (let i = 0; i < 2; i++) messages.push(frame({ protocol: PROTOCOL, kind: 'request.start', jobId, requestId: 1, accept: 'application/json' }));
    }
    input.end(Buffer.concat(messages));
    await expect(result).rejects.toThrow(); expect(target.received).toHaveLength(0);
  });
  it('accepts an immediate native retry and result when the terminal response is received before its write callback settles', async () => {
    const target = await fixture(); const input = new PassThrough(); const output = new PassThrough();
    const decoder = new FrameReader();
    const request = (id: number) => {
      input.write(frame({ protocol: PROTOCOL, kind: 'request.start', jobId, requestId: id, accept: 'application/json' }));
      input.write(frame({ protocol: PROTOCOL, kind: 'request.data', jobId, requestId: id,
        data: Buffer.from(JSON.stringify({ model: 'owner/model' })).toString('base64') }));
      input.write(frame({ protocol: PROTOCOL, kind: 'request.end', jobId, requestId: id }));
    };
    output.on('data', chunk => {
      for (const bytes of decoder.push(chunk)) {
        const message = parseHostMessage(parseJson(bytes));
        if (message.kind === 'input.end') request(1);
        if (message.kind === 'response.end') {
          if (message.requestId === 1) request(2);
          else input.write(frame({ protocol: PROTOCOL, kind: 'result', jobId,
            run: { status: 'succeeded', harness: 'pi', exitCode: 0, durationMs: 1 } }));
        }
      }
    });
    const broker = new ModelBroker({ jobId, model: 'owner/model', url: target.url, credential: key, timeoutMs: 2000, maxRequests: 2 }); brokers.push(broker);
    const result = runWorkerJob({ input, output, identity, broker, prompt: { system: 's', user: 'u' },
      settings: { model: { provider: 'p', endpoint: target.url, model: 'owner/model' }, credential: undefined, timeoutMs: 2000, workDirectory: '/private' } });
    input.write(frame({ protocol: PROTOCOL, kind: 'hello', identity }));
    expect((await result).status).toBe('succeeded'); expect(target.received).toHaveLength(2);
  });
  it('revokes and closes channel resources after invalid trusted startup data', async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const broker = new ModelBroker({ jobId, model: 'm', url: 'http://127.0.0.1:1', credential: undefined, timeoutMs: 5000, maxRequests: 1 }); brokers.push(broker);
    await expect(runWorkerJob({ input, output, identity: { ...identity, revision: 'invalid' }, broker,
      prompt: { system: 's', user: 'u' }, settings: { model: { provider: 'p', endpoint: 'http://127.0.0.1:1', model: 'm' },
        credential: undefined, workDirectory: '/private', timeoutMs: 5000 } })).rejects.toThrow('Invalid worker job');
    expect(input.destroyed).toBe(true); expect(output.destroyed).toBe(true); expect(broker.signal.aborted).toBe(true);
  });
  it('does not extend an incomplete-frame deadline when partial bytes keep arriving', async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough(); const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
      const broker = new ModelBroker({ jobId, model: 'm', url: 'http://127.0.0.1:1', credential: undefined, timeoutMs: 60_000, maxRequests: 1 }); brokers.push(broker);
      const rejected = expect(runWorkerJob({ input, output, identity, broker, prompt: { system: 's', user: 'u' },
        settings: { model: { provider: 'p', endpoint: 'http://127.0.0.1:1', model: 'm' }, credential: undefined,
          workDirectory: '/private', timeoutMs: 60_000 } })).rejects.toBeInstanceOf(WorkerFault);
      input.write(Buffer.from('Content-L'));
      await vi.advanceTimersByTimeAsync(9000); input.write(Buffer.from('e'));
      await vi.advanceTimersByTimeAsync(1100); await rejected;
      expect(broker.signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('bounds a writer stalled during invocation handoff', async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough(); const output = new Writable({ write() {} });
      const broker = new ModelBroker({ jobId, model: 'm', url: 'http://127.0.0.1:1', credential: undefined, timeoutMs: 100, maxRequests: 1 });
      brokers.push(broker);
      const result = runWorkerJob({ input, output, identity, settings: { model: { provider: 'p', endpoint: 'http://127.0.0.1:1', model: 'm' },
        credential: undefined, workDirectory: '/private', timeoutMs: 100 }, prompt: { system: 's', user: 'u' }, broker });
      const rejected = expect(result).rejects.toThrow();
      input.write(frame({ protocol: PROTOCOL, kind: 'hello', identity }));
      await vi.advanceTimersByTimeAsync(5100); await rejected;
      expect(broker.signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
