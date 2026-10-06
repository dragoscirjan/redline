/**
 * Opt-in live harness integration tests.
 *
 * These run the real Pi and OpenCode CLIs against a local mock model server.
 * Enable with REDLINE_LIVE_HARNESS_TESTS=1; each harness additionally
 * requires its binary on PATH (skipped otherwise). No network access
 * beyond loopback and no real credentials are used.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHarnessExecutor } from '../src/harness-executor/registry.js';
import { parseReviewEnvironment } from '../src/review/environment.js';
import { runFileReviews } from '../src/review/runner.js';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.js';

const ENABLED = process.env.REDLINE_LIVE_HARNESS_TESTS === '1';

async function binaryAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(command, ['--version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0 || code === 1));
  });
}

interface MockServer {
  readonly port: number;
  stop(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const script = fileURLToPath(new URL('./fixtures/mock-model-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
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

async function withLiveHarness(harness: 'pi' | 'opencode', test: (port: number) => Promise<void>): Promise<void> {
  if (!ENABLED) return;
  if (!(await binaryAvailable(harness))) return;
  const server = await startMockServer();
  try {
    await test(server.port);
  } finally {
    await server.stop();
  }
}

describe.skipIf(!ENABLED)('live harness integration', () => {
  it.runIf(ENABLED)('pi runs the full review against the mock endpoint', async () => {
    await withLiveHarness('pi', async (port) => {
      const fixture = await createBundleFixture();
      try {
        const env = {
          ...cleanReviewEnvironment(fixture, 'pi'),
          REDLINE_MODEL_CONFIG: JSON.stringify({
            provider: 'mock',
            endpoint: `http://127.0.0.1:${port}/v1`,
            model: 'test-model',
          }),
          REDLINE_TIMEOUT: '2m',
        };
        const parsed = parseReviewEnvironment(env);
        const result = await runFileReviews({ environment: parsed.review! });
        expect(result.summary.harness).toBe('pi');
        expect(result.summary.reviewedFiles).toBe(1);
        const record = JSON.parse(
          await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
        ) as { outcome: string };
        // The mock extracts the file id from the prompt and answers with a
        // matching clean review, so the pipeline must end clean.
        expect(record.outcome).toBe('clean');
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it.runIf(ENABLED)('opencode runs the full review against the mock endpoint', async () => {
    await withLiveHarness('opencode', async (port) => {
      const fixture = await createBundleFixture();
      try {
        const env = {
          ...cleanReviewEnvironment(fixture, 'opencode'),
          REDLINE_MODEL_CONFIG: JSON.stringify({
            provider: 'mock',
            endpoint: `http://127.0.0.1:${port}/v1`,
            model: 'test-model',
          }),
          REDLINE_TIMEOUT: '5m',
        };
        const parsed = parseReviewEnvironment(env);
        const result = await runFileReviews({ environment: parsed.review! });
        expect(result.summary.harness).toBe('opencode');
        expect(result.summary.reviewedFiles).toBe(1);
        const record = JSON.parse(
          await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
        ) as { outcome: string };
        expect(record.outcome).toBe('clean');
      } finally {
        await fixture.cleanup();
      }
    });
  });
});
