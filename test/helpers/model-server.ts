/** Trusted loopback-only fixture lifecycle; no package dependencies or ambient credentials. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

interface MockServer {
  readonly port: number;
  stop(): Promise<void>;
}

interface MockServerStartOptions {
  readonly spawn?: () => ChildProcess;
  readonly timeoutMs?: number;
}

export async function startMockServer(overrides: Record<string, string> = {}, options: MockServerStartOptions = {}): Promise<MockServer> {
  const script = fileURLToPath(new URL('../fixtures/mock-model-server.mjs', import.meta.url));
  const child = options.spawn?.() ?? spawn(process.execPath, [script, '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...overrides },
  });
  const closed = new Promise<void>((resolve) => {
    const onError = (): void => { if (child.pid === undefined) resolve(); };
    child.on('error', onError);
    child.once('close', () => { child.off('error', onError); resolve(); });
  });
  const waitForClosed = async (milliseconds: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const terminate = async (graceful: boolean): Promise<void> => {
    if (graceful) {
      child.kill();
      if (await waitForClosed(1_000)) return;
    }
    child.kill('SIGKILL');
    if (!await waitForClosed(1_000)) throw new Error('mock server did not exit after SIGKILL');
  };
  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      let buffer = ''; let settled = false;
      const finish = (result: { port: number } | { error: Error }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.stdout?.off('data', onData); child.stdout?.off('error', onError);
        child.off('close', onClose); child.off('error', onError);
        if ('error' in result) reject(result.error); else resolve(result.port);
      };
      const onError = (error: Error): void => finish({ error });
      const onClose = (): void => finish({ error: new Error('mock server exited before printing its port') });
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > 4_096) return finish({ error: new Error('mock startup metadata exceeds its byte limit') });
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        let value: unknown;
        try { value = JSON.parse(buffer.slice(0, newline)); }
        catch { return finish({ error: new Error('mock server printed invalid startup metadata') }); }
        const selected = value !== null && typeof value === 'object' && 'port' in value ? value.port : undefined;
        if (typeof selected !== 'number' || !Number.isInteger(selected) || selected < 1 || selected > 65_535) {
          return finish({ error: new Error('mock server printed an invalid port') });
        }
        finish({ port: selected });
      };
      const timeout = setTimeout(() => finish({ error: new Error('mock server did not start') }), options.timeoutMs ?? 10_000);
      child.once('close', onClose); child.once('error', onError);
      if (child.stdout === null) finish({ error: new Error('mock server has no startup stream') });
      else { child.stdout.on('data', onData); child.stdout.once('error', onError); }
    });
  } catch (error) {
    try { await terminate(false); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'mock server startup and cleanup failed'); }
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return { port, stop: () => stopping ??= terminate(true) };
}

/** Real SDK failure boundary; counts requests without recording bodies or headers. */
export async function startErrorServer(status: number, message: string, headers: Readonly<Record<string, string>> = {}): Promise<MockServer & { requests(): number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1; request.resume();
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify({ error: { code: status, message, type: 'invalid_request_error' } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock error server has no port');
  return { port: address.port, requests: () => requests,
    stop: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections(); server.close(error => error === undefined ? resolve() : reject(error));
    }) };
}

