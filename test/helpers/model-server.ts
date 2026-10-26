/** Trusted loopback-only fixture lifecycle; no package dependencies or ambient credentials. */
import { spawn } from 'node:child_process';
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
    stop: () =>
      new Promise<void>((resolve) => {
        child.kill();
        child.once('close', () => resolve());
      }),
  };
}

