/**
 * Opt-in live local-model integration test.
 *
 * Runs the real review pipeline end to end against a local OpenAI-compatible
 * model server (Ollama, LM Studio, llama.cpp server, vLLM) with the
 * credential-less `auth: "none"` profile. Enable with
 * REDLINE_LOCAL_MODEL_TESTS=1; additionally set REDLINE_LOCAL_MODEL_CONFIG
 * to the model config JSON and REDLINE_LOCAL_MODEL_BIN to the harness
 * binary (default `pi`). Skipped unless the endpoint answers on `/v1/models`.
 */

import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseReviewEnvironment } from '../src/review/environment.js';
import { runFileReviews } from '../src/review/runner.js';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.js';

const ENABLED = process.env.REDLINE_LOCAL_MODEL_TESTS === '1';
const MODEL_CONFIG = process.env.REDLINE_LOCAL_MODEL_CONFIG ?? '';
const MODEL_ENDPOINT = (() => {
  try {
    return MODEL_CONFIG.length > 0 ? new URL(JSON.parse(MODEL_CONFIG).endpoint).origin : '';
  } catch {
    return '';
  }
})();
const HARNESS_BIN = process.env.REDLINE_LOCAL_MODEL_BIN ?? 'pi';

async function binaryAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(command, ['--version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0 || code === 1));
  });
}

async function endpointAlive(endpoint: string): Promise<boolean> {
  if (endpoint.length === 0) return false;
  return new Promise((resolve) => {
    const probe = spawn('curl', ['-s', '-m', '3', `${endpoint}/v1/models`], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

describe.skipIf(!ENABLED)('local model runner integration', () => {
  it('reviews the fixture bundle with the credential-less profile', async () => {
    expect(MODEL_CONFIG).toMatch(/"auth"\s*:\s*"none"/u);
    expect(await binaryAvailable(HARNESS_BIN)).toBe(true);
    expect(await endpointAlive(MODEL_ENDPOINT)).toBe(true);

    const fixture = await createBundleFixture();
    try {
      const environment = {
        ...cleanReviewEnvironment(fixture, HARNESS_BIN),
        REDLINE_MODEL_CONFIG: MODEL_CONFIG,
        REDLINE_MODEL_AUTH: '',
        REDLINE_FINDING_SCOPE: 'defects',
      };
      const parsed = parseReviewEnvironment(environment);
      expect(parsed.mode).toBe('review');
      expect(parsed.review?.credential).toBeUndefined();
      const result = await runFileReviews({ environment: parsed.review as NonNullable<typeof parsed.review> });
      expect(result.records.length).toBeGreaterThan(0);
      for (const record of result.records) {
        expect(['clean', 'findings', 'omitted']).toContain(record.outcome);
      }
      console.log(
        `local model review: ${result.summary.reviewedFiles} reviewed, ${result.summary.findings} findings, ` +
          `${result.summary.omittedFiles} omitted ` +
          `(${JSON.stringify(result.summary.files.map((file) => `${file.path}: ${file.outcome}${file.errorKind === undefined ? '' : ` (${file.errorKind})`}`))})`,
      );
    } finally {
      await fixture.cleanup();
    }
  }, 900_000);
});
