import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { FrameReader, FrameWriter, FramingError, frame } from '../src/rpc/framing.ts';
import { LIMITS, valid, params, assertSchemaVocabulary } from '../src/rpc/contract.ts';

describe('RPC framing and committed schemas', () => {
  it('counts UTF-8 bytes and accepts every possible split boundary', () => {
    const message = { jsonrpc: '2.0', id: '雪', method: 'redline/v1/initialize', params: { protocolVersion: '1.0' } };
    const encoded = frame(message);
    expect(encoded.toString()).toContain('Content-Length: ' + Buffer.byteLength(JSON.stringify(message)));
    for (let n = 0; n <= encoded.length; n++) {
      const reader = new FrameReader();
      const values = [...reader.push(encoded.subarray(0, n)), ...reader.push(encoded.subarray(n))];
      reader.end();
      expect(values.map(bytes => JSON.parse(bytes.toString()))).toEqual([message]);
    }
  });
  it('decodes coalesced frames and byte-at-a-time input', () => {
    const input = Buffer.concat([frame({ id: 0 }), frame({ id: 1 })]);
    const reader = new FrameReader(); const values: Buffer[] = [];
    for (const byte of input) values.push(...reader.push(Buffer.from([byte])));
    expect(values.map(v => JSON.parse(v.toString()))).toEqual([{ id: 0 }, { id: 1 }]); reader.end();
    expect(new FrameReader().push(input)).toHaveLength(2);
  });
  it.each([
    'Content-Length: 0\r\n\r\n', 'Content-Length: -1\r\n\r\n', 'Content-Length: 1.2\r\n\r\n',
    'Content-Length: 01\r\n\r\n', 'Content-Length: 1048577\r\n\r\n',
    'Content-Length: 1\r\nContent-Length: 1\r\n\r\n',
    'X: x\r\nContent-Length: 1\r\n\r\n', 'x'.repeat(1024),
  ])('rejects unsafe frame headers %s', value => { expect(() => new FrameReader().push(Buffer.from(value))).toThrow(); });
  it('rejects high-bit header aliases, truncation, oversized output and too many queued frames', () => {
    const bytes = Buffer.from('Content-Length: 1\r\n\r\n0'); bytes[0] = 0xc3;
    expect(() => new FrameReader().push(bytes)).toThrow('Non-ASCII');
    const reader = new FrameReader(); reader.push(Buffer.from('Content-Length: 10\r\n\r\n{}'));
    expect(() => reader.end()).toThrow('Truncated');
    expect(() => frame('x'.repeat(LIMITS.messageBytes))).toThrow('limit');
    expect(() => new FrameReader().push(Buffer.concat(Array.from({ length: 33 }, () => frame(0))))).toThrow();
  });
  it('rejects a large coalesced stream of minimum-sized frames as a framing error', () => {
    const tiny = frame(0);
    const input = Buffer.concat(Array.from({ length: 4096 }, () => tiny));
    expect(input.length).toBeGreaterThan(64 * 1024);
    expect(() => new FrameReader().push(input)).toThrow(FramingError);
  });
  it('bounds decoded message bytes before buffering another complete body', () => {
    const encoded = frame('x'.repeat(LIMITS.messageBytes - 2));
    expect(() => new FrameReader().push(Buffer.concat([encoded, encoded, encoded]))).toThrow('byte limit');
  });
  it('backs off optional progress, bounds mandatory writes, and times out a stalled reader', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const writer = new FrameWriter(new Writable({ write() {} }), failed);
    expect(writer.send({ hello: 'world' })).toBe(true);
    await vi.advanceTimersByTimeAsync(LIMITS.writeTimeoutMs);
    await writer.flush(); expect(failed).toHaveBeenCalledTimes(1);
    expect(writer.send({ id: 1 })).toBe(false); writer.dispose(); vi.useRealTimers();
  });
  it('drops optional updates before consuming the slots reserved for responses', async () => {
    const writer = new FrameWriter(new Writable({ write(_chunk, _encoding, done) { done(); } }), () => {});
    for (let i = 0; i < 16; i++) expect(writer.send({ event: i }, true)).toBe(true);
    expect(writer.send({ event: 17 }, true)).toBe(false);
    expect(writer.send({ result: true })).toBe(true);
    await writer.flush(); writer.dispose();
  });
  it('fails closed instead of ignoring unsupported schema vocabulary', () => {
    expect(() => assertSchemaVocabulary({ type: 'string', format: 'uri' })).toThrow('vocabulary');
    expect(() => assertSchemaVocabulary({ type: ['string', 'null'] })).toThrow('type');
    expect(() => assertSchemaVocabulary({ type: ['string'] })).toThrow('type');
    expect(() => assertSchemaVocabulary({ $ref: '#/$defs/id', minimum: 1 })).toThrow('reference');
    expect(() => assertSchemaVocabulary({ type: 'object', additionalProperties: { type: 'string' } })).toThrow();
  });
  it('validates all source selectors before execution and forbids wire credentials/settings', () => {
    expect(valid('startParams', { repository: '/repo', worktree: 'staged' })).toBe(true);
    for (const extra of [{ head: 'HEAD', worktree: 'all' }, { comparison: 'direct' }, { head: 'HEAD', untracked: 'include' },
      { worktree: 'staged', untracked: 'include' }, { base: 'bad\u0000revision' },
      { 'model-auth': 'secret' }, { config: '/private' }, { endpoint: 'https://evil.invalid' }, { output: '/tmp/arbitrary' }]) {
      expect(valid('startParams', { repository: '/repo', ...extra })).toBe(false);
    }
    expect(() => params('result', { runId: 'bad' })).toThrow('Invalid params');
    expect(valid('request', { jsonrpc: '2.0', id: 0, method: 'unknown' })).toBe(true);
    expect(valid('request', { jsonrpc: '2.0', id: null, method: 'unknown' })).toBe(false);
  });
});
