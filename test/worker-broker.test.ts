import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelBroker } from '../src/harness-worker/broker.ts';
import { CredentialStream } from '../src/harness-worker/redaction.ts';
import { credentialTextForms, redactCredentialText } from '../src/harness-executor/model-failure.ts';
import { decodeData, parseHostMessage, type HostMessage } from '../src/harness-worker/contract.ts';

const jobId = '00000000-0000-4000-8000-000000000001';
const key = 'synthetic-provider-key/+%?=';
const model = 'owner/model';
const servers: Server[] = [];
const brokers: ModelBroker[] = [];
afterEach(async () => {
  for (const broker of brokers.splice(0)) broker.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
});
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}/api/chat/completions`;
}
function broker(url: string, extra: Partial<ConstructorParameters<typeof ModelBroker>[0]> = {}): ModelBroker {
  const instance = new ModelBroker({ jobId, model, url, credential: key, timeoutMs: 5000, maxRequests: 6, ...extra });
  brokers.push(instance); return instance;
}
function body(extra = {}): Buffer { return Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'data' }], ...extra })); }
async function collect(b: ModelBroker, id: number, input = body()): Promise<HostMessage[]> {
  const messages = [];
  for await (const event of b.request(id, input, 'application/json')) { parseHostMessage(event); messages.push(event); }
  return messages;
}
function text(events: HostMessage[]): string {
  return Buffer.concat(events.flatMap(e => e.kind === 'response.data' ? [decodeData(e.data)] : [])).toString();
}

describe('job-scoped host model broker', () => {
  it('preserves model bytes/settings/status/retry headers and keeps authentication outside the wire', async () => {
    let observedBody = ''; let observedAuth: string | undefined; let observedPath = '';
    const url = await endpoint(async (req, res) => {
      observedAuth = req.headers.authorization; observedPath = req.url ?? '';
      for await (const chunk of req) observedBody += String(chunk);
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2', 'retry-after-ms': '10',
        'set-cookie': 'private-cookie', location: 'https://unrelated.invalid', 'x-request-id': key });
      res.end(JSON.stringify({ error: 'upstream reflected ' + key }));
    });
    const input = body({ stream: true, max_tokens: 4096, reasoning: { effort: 'high' },
      provider: { require_parameters: true }, response_format: { type: 'json_object' } });
    const lease = broker(url, { maxOutputTokens: 4096 });
    expect(JSON.stringify(lease)).toBe(JSON.stringify({ jobId, model }));
    expect(Object.getOwnPropertyNames(lease)).not.toContain('credential');
    expect(Object.getOwnPropertyNames(lease)).not.toContain('url');
    const events = await collect(lease, 1, input);
    expect(observedBody).toBe(input.toString()); expect(observedAuth).toBe('Bearer ' + key);
    expect(observedPath).toBe('/api/chat/completions');
    expect(events[0]).toMatchObject({ kind: 'response.start', status: 429,
      headers: { 'retry-after': '2', 'retry-after-ms': '10', 'x-request-id': '[redacted]' } });
    expect(JSON.stringify(events)).not.toContain(key);
    expect(events[0]).not.toHaveProperty('headers.location'); expect(events[0]).not.toHaveProperty('headers.set-cookie');
    expect(text(events)).toContain('[redacted]'); expect(events.at(-1)?.kind).toBe('response.end');
  });
  it('streams without waiting for the complete body, preserves UTF-8 and decodes compressed responses', async () => {
    let finish: (() => void) | undefined;
    const url = await endpoint((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + '雪'.repeat(200) + '\n\n'); finish = () => res.end('data: [DONE]\n\n');
    });
    const iterator = broker(url, { credential: undefined }).request(1, body(), 'text/event-stream');
    expect((await iterator.next()).value).toMatchObject({ kind: 'response.start' });
    const first = (await iterator.next()).value;
    expect(first).toMatchObject({ kind: 'response.data' });
    if (first?.kind !== 'response.data') throw new Error('No streamed data');
    expect(decodeData(first.data).toString()).toContain('雪');
    finish?.();
    for await (const _event of iterator) { /* drain */ }
    const compressed = await endpoint((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from('{"ok":"雪"}')));
    });
    const events = await collect(broker(compressed), 1);
    expect(text(events)).toBe('{"ok":"雪"}'); expect(events[0]).not.toHaveProperty('headers.content-encoding');
  });
  it('preserves auth-none and native request allowances without making its own retries', async () => {
    let calls = 0;
    const url = await endpoint((req, res) => { calls++; expect(req.headers.authorization).toBeUndefined(); res.writeHead(503); res.end('busy'); });
    const b = broker(url, { credential: undefined });
    for (let id = 1; id <= 6; id++) expect((await collect(b, id))[0]).toMatchObject({ status: 503 });
    expect(calls).toBe(6);
    await expect(collect(b, 7)).rejects.toThrow('denied'); expect(calls).toBe(6);
  });
  it('rejects unauthorized models, tools, cap changes, replay and closed leases before network effects', async () => {
    let calls = 0;
    const url = await endpoint((_req, res) => { calls++; res.end('{}'); });
    const b = broker(url, { maxOutputTokens: 4096 });
    for (const input of [body({ model: 'other', max_tokens: 4096 }), body({ tools: [{ type: 'function' }], max_tokens: 4096 }),
      body({ functions: [{}], max_tokens: 4096 }), body({ plugins: [{}], max_tokens: 4096 }), body({ agents: 'remote', max_tokens: 4096 }),
      body({ max_completion_tokens: 4096, max_tokens: 8192 }), body({ max_tokens: 4096, max_completion_tokens: null }),
      body({ max_tokens: 8192 }), body(), Buffer.from('not-json')]) {
      await expect(collect(b, 1, input)).rejects.toThrow();
    }
    expect(calls).toBe(0);
    await collect(b, 1, body({ max_tokens: 4096 }));
    await expect(collect(b, 1, body({ max_tokens: 4096 }))).rejects.toThrow();
    b.close(); await expect(collect(b, 2, body({ max_tokens: 4096 }))).rejects.toThrow(); expect(calls).toBe(1);
  });
  it('cancels an active upstream stream and revokes the job at deadline or external abort', async () => {
    let closed: (() => void) | undefined;
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const url = await endpoint((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: waiting\n\n');
      res.on('close', () => closed?.());
    });
    const controller = new AbortController();
    const b = broker(url, { signal: controller.signal, credential: undefined });
    const iterator = b.request(1, body(), 'text/event-stream');
    await iterator.next(); await iterator.next(); controller.abort();
    const events: HostMessage[] = []; for await (const e of iterator) events.push(e);
    expect(events.at(-1)).toMatchObject({ kind: 'response.error', code: 'transport' });
    await disconnected; await expect(collect(b, 2)).rejects.toThrow();
    const expired = broker(url, { timeoutMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 25));
    await expect(collect(expired, 1)).rejects.toThrow();
  });
  it('bounds response/header bytes, rejects malformed UTF-8, and releases an abandoned response', async () => {
    const large = await endpoint((_req, res) => res.end('x'.repeat(4096)));
    const events = await collect(broker(large, { maxResponseBytes: 1024 }), 1);
    expect(events.at(-1)).toMatchObject({ kind: 'response.error', code: 'limit' });
    expect(events.some(e => e.kind === 'response.end')).toBe(false);
    const headers = await endpoint((_req, res) => { res.writeHead(200, { 'x-ratelimit-test': 'x'.repeat(9000) }); res.end('{}'); });
    expect((await collect(broker(headers), 1)).at(-1)).toMatchObject({ code: 'limit' });
    const invalid = await endpoint((_req, res) => res.end(Buffer.from([0xff])));
    expect((await collect(broker(invalid), 1)).at(-1)).toMatchObject({ code: 'transport' });
    let disconnected: (() => void) | undefined;
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const streaming = await endpoint((_req, res) => { res.writeHead(200); res.write('waiting'); res.on('close', () => disconnected?.()); });
    const iterator = broker(streaming).request(1, body(), 'application/json');
    await iterator.next(); await iterator.return(undefined); await closed;
  });
  it('never follows redirects to a second target or exposes URL details on transport failure', async () => {
    let extraCalls = 0;
    const other = await endpoint((_req, res) => { extraCalls++; res.end('{}'); });
    const url = await endpoint((_req, res) => { res.writeHead(307, { location: other }); res.end('redirect'); });
    const events = await collect(broker(url), 1);
    expect(events[0]).toMatchObject({ status: 307 }); expect(extraCalls).toBe(0);
    expect(events[0]).not.toHaveProperty('headers.location');
    const failure = await collect(broker('http://127.0.0.1:1/private?key=' + key), 1);
    expect(failure).toEqual([{ protocol: 'redline-worker/v1', jobId, requestId: 1, kind: 'response.error', code: 'transport' }]);
    expect(JSON.stringify(failure)).not.toContain(key);
  });
});

describe('streaming credential redaction', () => {
  it('redacts every supported form at every split, including percent case and UTF-8 boundaries', () => {
    const secret = 'private/雪+%\"value';
    for (const [form, encoded] of credentialTextForms(secret)) {
      const sample = 'before 雪 ' + (encoded ? form.replace(/%[0-9A-F]{2}/gu, s => s.toLowerCase()) : form) + ' after 雪';
      const bytes = Buffer.from(sample);
      for (let split = 0; split <= bytes.length; split++) {
        const stream = new CredentialStream(secret);
        const output = Buffer.concat([stream.push(bytes.subarray(0, split)), stream.push(bytes.subarray(split)), stream.push(Buffer.alloc(0), true)]).toString();
        expect(output).toBe(redactCredentialText(sample, secret));
      }
    }
  });
  it('handles overlapping occurrences, adjacent secrets and one-byte chunks without losing Unicode', () => {
    for (const secret of ['abab', 'aaaa', 'test-key']) {
      const sample = '雪' + secret.repeat(50) + '尾'; const stream = new CredentialStream(secret); const parts = [];
      for (const byte of Buffer.from(sample)) parts.push(stream.push(Buffer.from([byte])));
      parts.push(stream.push(Buffer.alloc(0), true));
      expect(Buffer.concat(parts).toString()).toBe(redactCredentialText(sample, secret));
    }
  });
});
