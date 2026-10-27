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
});

it('can stop a fixture again after its process has already closed', async () => {
  const server = await startMockServer();
  await server.stop();
  await server.stop();
}, 2000);

it('serves controlled HTTP errors without recording request bodies or headers', async () => {
  const server = await startErrorServer(401, 'Invalid fixture key');
  try {
    const result = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: 'POST', body: 'fixture data' });
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ error: { message: 'Invalid fixture key' } });
    expect(server.requests()).toBe(1);
  } finally { await server.stop(); }
});
