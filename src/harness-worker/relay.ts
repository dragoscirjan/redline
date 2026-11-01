import { createServer, type Server, type ServerResponse } from 'node:http';
import { chunks, decodeData, LIMITS, PROTOCOL, WorkerFault, type HostMessage, type WorkerMessage, type Accept } from './contract.ts';

/** Loopback-only HTTP facade for the SDK. The only upstream is the owned byte channel. */
export class ModelRelay {
  private readonly server: Server;
  private readonly send: (message: WorkerMessage) => Promise<void>;
  private readonly jobId: string;
  private readonly signal: AbortSignal;
  private pending: { id: number; response: ServerResponse; started: boolean; done: boolean } | undefined;
  private requests = 0;
  private address = '';
  limitExceeded = false;
  constructor(jobId: string, send: (message: WorkerMessage) => Promise<void>, signal: AbortSignal) {
    this.jobId = jobId; this.send = send; this.signal = signal;
    this.server = createServer((request, response) => {
      void (async () => {
        if (signal.aborted || this.pending !== undefined || request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          response.writeHead(403); response.end(); return;
        }
        let size = 0; const parts: Buffer[] = [];
        for await (const part of request) {
          const bytes = Buffer.from(part); size += bytes.length;
          if (size > LIMITS.payloadBytes) throw new WorkerFault('Worker request exceeds byte limit');
          parts.push(bytes);
        }
        const id = ++this.requests;
        const pending = { id, response, started: false, done: false }; this.pending = pending;
        response.on('error', () => undefined);
        const rawAccept = request.headers.accept ?? '*/*';
        const accept: Accept = rawAccept.includes('text/event-stream') ? 'text/event-stream' : rawAccept.includes('application/json') ? 'application/json' : '*/*';
        await this.send({ protocol: PROTOCOL, kind: 'request.start', jobId, requestId: id, accept });
        for (const data of chunks(Buffer.concat(parts))) await this.send({ protocol: PROTOCOL, kind: 'request.data', jobId, requestId: id, data });
        await this.send({ protocol: PROTOCOL, kind: 'request.end', jobId, requestId: id });
      })().catch(() => { if (!response.headersSent) response.writeHead(502); response.destroy(); });
    });
    signal.addEventListener('abort', this.abort, { once: true });
  }
  get endpoint(): string { return this.address + '/v1'; }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new WorkerFault();
    this.address = `http://127.0.0.1:${address.port}`;
    if (this.signal.aborted) this.abort();
  }
  async receive(message: HostMessage): Promise<void> {
    if (!message.kind.startsWith('response.') || !('requestId' in message)) throw new WorkerFault();
    const pending = this.pending;
    if (pending === undefined || message.requestId !== pending.id || pending.done) throw new WorkerFault();
    switch (message.kind) {
      case 'response.start':
        if (pending.started) throw new WorkerFault();
        pending.started = true; pending.response.writeHead(message.status, { ...message.headers }); break;
      case 'response.data':
        if (!pending.started) throw new WorkerFault();
        if (!pending.response.write(decodeData(message.data))) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = (): void => { pending.response.off('drain', drain); pending.response.off('close', close); };
            const drain = (): void => { cleanup(); resolve(); };
            const close = (): void => { cleanup(); reject(new WorkerFault('SDK response closed')); };
            pending.response.once('drain', drain); pending.response.once('close', close);
            if (pending.response.destroyed) close();
          });
        }
        break;
      case 'response.end':
        if (!pending.started) throw new WorkerFault();
        pending.done = true; this.pending = undefined; pending.response.end(); break;
      case 'response.error':
        pending.done = true; this.pending = undefined;
        if (message.code === 'limit') this.limitExceeded = true;
        if (!pending.started) { pending.response.writeHead(502, { 'content-type': 'application/json' }); pending.response.end('{"error":{"message":"Model transport failed"}}'); }
        else pending.response.destroy();
        break;
      default: throw new WorkerFault();
    }
  }
  private readonly abort = (): void => {
    this.pending?.response.destroy(); this.pending = undefined; this.server.closeAllConnections(); this.server.close();
  };
  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.abort);
    this.pending?.response.destroy(); this.pending = undefined; this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
