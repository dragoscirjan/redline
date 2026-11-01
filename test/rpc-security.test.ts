import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.useRealTimers());
import { redactCredentialText } from '../src/harness-executor/model-failure.ts';
import { CODES, LIMITS } from '../src/rpc/contract.ts';
import { Session } from '../src/rpc/session.ts';
import { frame } from '../src/rpc/framing.ts';
import { serve } from '../src/rpc/server.ts';
import { classification, type Completion } from '../src/rpc/local.ts';

const result: Completion = { state: 'completed', exitCode: 0, error: null };
describe('RPC resource and security boundaries', () => {
  it('redacts encoded credentials without rewriting evidence whitespace', () => {
    const credential = 'secret!value*with/space';
    const encoded = encodeURIComponent(encodeURIComponent(credential));
    expect(redactCredentialText('line one\n  ' + encoded + '\tline two\n', credential)).toBe('line one\n  [redacted]\tline two\n');
  });
  it.each([
    ['harness-timeout', CODES.timeout], ['run-deadline-exhausted', CODES.timeout],
    ['invalid-output', CODES.validation], ['verification-failed', CODES.validation],
    ['harness-failed', CODES.model], ['preparation-failed', CODES.model],
  ])('keeps the stable category for %s', (kind, code) => { expect(classification(kind).code).toBe(code); });
  it('rejects relative paths and invalid selectors before calling execution', async () => {
    const execute = vi.fn(async () => result); const messages: unknown[] = [];
    const session = new Session({ execute, once: false, send: value => { messages.push(value); return true; } });
    session.receive({ jsonrpc: '2.0', id: 1, method: 'redline/v1/initialize', params: { protocolVersion: '1.0' } });
    for (const params of [{ repository: 'relative' }, { repository: '/repo', worktree: 'staged', untracked: 'include' }]) {
      session.receive({ jsonrpc: '2.0', id: 2, method: 'redline/v1/review.start', params });
      expect(messages.at(-1)).toMatchObject({ error: { code: CODES.params } });
    }
    expect(execute).not.toHaveBeenCalled(); await session.end();
  });
  it('interrupts an active executor when a peer stops draining output', async () => {
    vi.useFakeTimers();
    const input = new PassThrough(); let writes = 0; let aborted = false;
    let markStarted = () => {}; let markBlocked = () => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const blocked = new Promise<void>(resolve => { markBlocked = resolve; });
    const output = new Writable({ write(_chunk, _encoding, done) { if (++writes <= 2) done(); else markBlocked(); } });
    const running = serve({ input, output, execute: async (_selection, signal, callbacks) => {
      markStarted();
      callbacks.progress({ kind: 'started' });
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return { state: 'cancelled', exitCode: 130, error: { code: CODES.cancellation, message: 'Review cancelled' } };
    } });
    input.write(Buffer.concat([
      frame({ jsonrpc: '2.0', id: 1, method: 'redline/v1/initialize', params: { protocolVersion: '1.0' } }),
      frame({ jsonrpc: '2.0', id: 2, method: 'redline/v1/review.start', params: { repository: '/repo' } }),
    ]));
    await started;
    await vi.advanceTimersByTimeAsync(100);
    await blocked;
    await vi.advanceTimersByTimeAsync(LIMITS.writeTimeoutMs + 1);
    expect(await running).toBe(1); expect(aborted).toBe(true); vi.useRealTimers();
  });
  it('releases a real blocked stdout pipe so the process can exit', async () => {
    const { fileURLToPath } = await import('node:url');
    const binary = fileURLToPath(new URL('../bin/redline.mjs', import.meta.url));
    const child = spawn(process.execPath, [binary, 'rpc'], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let diagnostic = '';
    child.stderr.on('data', (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
    child.stdin.on('error', () => {});
    // Large envelopes keep each OS input chunk below the advertised frame-count bound.
    // The unknown method never reads configuration, captures source, or starts a model.
    const request = (i: number) => frame({ jsonrpc: '2.0', id: String(i).padEnd(128, 'x'), method: 'unknown', params: { padding: 'x'.repeat(4096) } });
    child.stdin.end(Buffer.concat(Array.from({ length: 4000 }, (_, i) => request(i))));
    let watchdogFired = false;
    const deadline = setTimeout(() => { watchdogFired = true; child.kill('SIGKILL'); }, 10_000);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject);
      });
      expect(watchdogFired, diagnostic).toBe(false);
      expect(result.code !== 0 || result.signal !== null).toBe(true);
      expect(diagnostic).toContain('redline rpc: output unavailable');
    } finally { clearTimeout(deadline); child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); }
  });
  it('maps process interrupts to exit 130 rather than a framing failure', async () => {
    const input = new PassThrough(); const controller = new AbortController();
    const output = new Writable({ write(_c, _e, done) { done(); } });
    const running = serve({ input, output, signal: controller.signal, execute: async () => result });
    controller.abort(); expect(await running).toBe(130);
  });
  it('still interrupts one-shot execution while draining after EOF', async () => {
    const input = new PassThrough(); const controller = new AbortController();
    const output = new Writable({ write(_c, _e, done) { done(); } });
    let started = () => {}; let settle = () => {}; let aborted = false;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = serve({ input, output, once: true, signal: controller.signal, execute: async (_s, signal) => {
      started(); await new Promise<void>(resolve => {
        settle = resolve; signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      });
      return { state: 'cancelled', exitCode: 130, error: null };
    } });
    input.end(Buffer.concat([
      frame({ jsonrpc: '2.0', id: 1, method: 'redline/v1/initialize', params: { protocolVersion: '1.0' } }),
      frame({ jsonrpc: '2.0', id: 2, method: 'redline/v1/review.start', params: { repository: '/repo' } }),
    ]));
    try {
      await ready; await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      controller.abort(); await new Promise(resolve => setImmediate(resolve));
      expect(aborted).toBe(true);
    } finally { settle(); expect(await running).toBe(130); }
  });
  it('does not retain oversized result payloads or claim a silently shortened result', async () => {
    const messages: unknown[] = [];
    const session = new Session({ once: false, execute: async () => ({ ...result, sections: {
      overview: [], files: [], findings: [{ fixPrompt: 'x'.repeat(LIMITS.retainedBytes / 2) }],
    } }), send: value => { messages.push(value); return true; } });
    session.receive({ jsonrpc: '2.0', id: 1, method: 'redline/v1/initialize', params: { protocolVersion: '1.0' } });
    session.receive({ jsonrpc: '2.0', id: 2, method: 'redline/v1/review.start', params: { repository: '/repo' } });
    await new Promise(resolve => setImmediate(resolve));
    const terminal = messages.find(value => typeof value === 'object' && value !== null && 'method' in value && value.method === 'redline/v1/finished');
    expect(terminal).toMatchObject({ params: { run: { state: 'completed', resultAvailable: false } } });
    await session.end();
  });
});
