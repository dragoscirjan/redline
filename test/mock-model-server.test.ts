import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { startErrorServer, startMockServer } from './helpers/model-server.ts';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fakeChild() {
  const child = new ChildProcess(); const output = new PassThrough(); child.stdout = output;
  const kill = vi.spyOn(child, 'kill').mockImplementation(() => { child.emit('close', null, 'SIGKILL'); return true; });
  return { child, output, kill };
}

it.each(['close', 'error', 'invalid JSON', 'invalid port', 'oversized metadata'])('cleans up failed fixture startup: %s', async (failure) => {
  const { child, output, kill } = fakeChild();
  const started = startMockServer({}, { spawn: () => child });
  const rejected = expect(started).rejects.toThrow(/mock|fixture/u);
  if (failure === 'close') child.emit('close', 1, null);
  else if (failure === 'error') child.emit('error', new Error('fixture spawn failed'));
  else output.write(failure === 'invalid JSON' ? 'not JSON\n' : failure === 'invalid port' ? '{"port":0}\n' : 'x'.repeat(4_097));
  await rejected;
  expect(kill).toHaveBeenCalledWith('SIGKILL');
  expect(output.listenerCount('data')).toBe(0);
});

it('kills and awaits a real hung child when startup times out', async () => {
  let child: ChildProcess | undefined;
  await expect(startMockServer({}, { timeoutMs: 100, spawn: () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }); return child;
  } })).rejects.toThrow('mock server did not start');
  if (child === undefined) throw new Error('child not created');
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

it('rejects promptly when a real fixture exits before its handshake', async () => {
  await expect(startMockServer({}, { spawn: () => spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  }) })).rejects.toThrow('exited before printing its port');
});

it('accepts a fragmented bounded handshake and removes its startup timer', async () => {
  vi.useFakeTimers();
  const { child, output, kill } = fakeChild();
  const started = startMockServer({}, { spawn: () => child });
  output.write('{"po'); output.write('rt":8787}\n');
  const server = await started;
  expect(server.port).toBe(8787); expect(kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await server.stop(); await server.stop();
  expect(kill).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it('escalates an ignored SIGTERM and shares one bounded stop operation', async () => {
  vi.useFakeTimers();
  const { child, output, kill } = fakeChild();
  kill.mockImplementation((signal) => { if (signal === 'SIGKILL') child.emit('close', null, 'SIGKILL'); return true; });
  const started = startMockServer({}, { spawn: () => child });
  output.write('{"port":8787}\n');
  const server = await started;
  const stopping = server.stop(); const again = server.stop();
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await stopping; await again;
    expect(kill).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { child.emit('close', null, 'SIGKILL'); await Promise.allSettled([stopping, again]); }
});

it('rejects teardown when even SIGKILL produces no close event', async () => {
  vi.useFakeTimers();
  const { child, output, kill } = fakeChild(); kill.mockImplementation(() => true);
  const started = startMockServer({}, { spawn: () => child }); output.write('{"port":8787}\n');
  const server = await started; const stopping = server.stop();
  let settled = false;
  const watched = stopping.then(() => { settled = true; }, () => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(true);
    await expect(stopping).rejects.toThrow('mock server did not exit after SIGKILL');
    expect(kill).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  } finally { child.emit('close', null, 'SIGKILL'); await Promise.allSettled([stopping, watched]); }
});

it('does not confuse a post-startup signal error with process exit', async () => {
  vi.useFakeTimers();
  const { child, output, kill } = fakeChild();
  Object.defineProperty(child, 'pid', { value: 123456 });
  kill.mockImplementation((signal) => {
    if (signal === 'SIGKILL') child.emit('close', null, 'SIGKILL');
    else child.emit('error', new Error('fixture signal failed'));
    return false;
  });
  const started = startMockServer({}, { spawn: () => child }); output.write('{"port":8787}\n');
  const server = await started; const stopping = server.stop();
  try {
    await vi.advanceTimersByTimeAsync(1_000); await stopping;
    expect(kill).toHaveBeenCalledWith('SIGKILL'); expect(kill).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { child.emit('close', null, 'SIGKILL'); await Promise.allSettled([stopping]); }
});

it('bounds forced cleanup after startup fails and preserves both errors', async () => {
  vi.useFakeTimers();
  const { child, output, kill } = fakeChild(); kill.mockImplementation(() => true);
  const started = startMockServer({}, { spawn: () => child });
  let settled = false;
  const watched = started.then(() => { settled = true; }, () => { settled = true; });
  output.write('not JSON\n');
  try {
    await vi.advanceTimersByTimeAsync(1_000); expect(settled).toBe(true);
    await expect(started).rejects.toMatchObject({ message: 'mock server startup and cleanup failed', errors: [
      expect.objectContaining({ message: 'mock server printed invalid startup metadata' }),
      expect.objectContaining({ message: 'mock server did not exit after SIGKILL' }),
    ] });
    expect(vi.getTimerCount()).toBe(0);
  } finally { child.emit('close', null, 'SIGKILL'); await Promise.allSettled([started, watched]); }
});

it('terminates an owned real fixture that ignores SIGTERM', async () => {
  let child: ChildProcess | undefined;
  const server = await startMockServer({}, { spawn: () => {
    child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log(JSON.stringify({port:8787})); setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }); return child;
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([server.stop(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('fixture shutdown exceeded its bound')), 3_000);
    })]);
    if (child === undefined) throw new Error('child not created');
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL');
  } finally {
    clearTimeout(timer); child?.kill('SIGKILL'); await server.stop().catch(() => undefined);
  }
});

it('can stop a fixture again after its process has already closed', async () => {
  const server = await startMockServer();
  await server.stop();
  await server.stop();
}, 2000);

it('serves fixed errors without exposing request content through responses, logs or its public API', async () => {
  const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}));
  const server = await startErrorServer(401, 'Invalid fixture key');
  const body = 'FIXTURE_REQUEST_BODY_SENTINEL';
  const authorization = 'FIXTURE_REQUEST_HEADER_SENTINEL';
  try {
    const result = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST', body, headers: { authorization },
    });
    expect(result.status).toBe(401);
    const response = await result.text();
    expect(JSON.parse(response)).toMatchObject({ error: { code: 401, message: 'Invalid fixture key' } });
    expect(response).not.toContain(body); expect(response).not.toContain(authorization);
    expect(Object.keys(server).sort()).toEqual(['port', 'requests', 'stop']);
    expect(server.requests()).toBe(1);
    for (const log of logs) {
      const output = JSON.stringify(log.mock.calls);
      expect(output).not.toContain(body); expect(output).not.toContain(authorization);
    }
  } finally { await server.stop(); }
});
