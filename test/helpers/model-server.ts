/** Trusted loopback-only fixture lifecycle; no package dependencies or ambient credentials. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

interface MockServer {
  readonly port: number;
  stop(): Promise<void>;
}

export async function startMockServer(overrides: Record<string, string> = {}): Promise<MockServer> {
  const script = fileURLToPath(new URL('../fixtures/mock-model-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...overrides },
  });
  const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('mock server did not start')), 10_000);
    child.stdout!.once('data', (chunk: Buffer) => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(chunk.toString()).port);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('mock server printed garbage'));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return {
    port,
    stop: async () => { child.kill(); await closed; },
  };
}

/** Real SDK failure boundary; counts requests without recording bodies or headers. */
export async function startErrorServer(status: number, message: string): Promise<MockServer & { requests(): number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1; request.resume();
    response.writeHead(status, { 'content-type': 'application/json' });
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

