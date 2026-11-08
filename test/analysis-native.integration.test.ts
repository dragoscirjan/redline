import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { runFileReviews } from '../src/review/runner.ts';
import { createBundleFixture, cleanReviewEnvironment } from './helpers/bundle.ts';

const enabled = process.env.REDLINE_MCP_INTEGRATION_TESTS === '1';
const key = 'synthetic-container-model-key-do-not-persist';
interface ModelRequest { authorization: string; body: { tools?: { function: { name: string } }[]; messages?: { role: string; content: unknown }[] } }
async function model() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/container-model.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, REDLINE_MOCK_MODE: 'analysis', REDLINE_MOCK_HOST: '127.0.0.1', REDLINE_MOCK_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const requests: ModelRequest[] = [];
  let lines = '', stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic model startup timed out')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Synthetic model exited: ' + stderr)); });
    child.stdout.on('data', chunk => {
      lines += String(chunk);
      for (;;) {
        const end = lines.indexOf('\n'); if (end < 0) break;
        const row = JSON.parse(lines.slice(0, end)); lines = lines.slice(end + 1);
        if (row.type === 'ready') { clearTimeout(timer); resolve(Number(row.port)); }
        if (row.type === 'request') requests.push(row as ModelRequest);
      }
    });
  });
  return { port, requests,
    /** Stop only this fixture's model-server process and wait for its exit. */
    async close() {
    if (child.exitCode !== null) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
  } };
}
describe.runIf(enabled)('native local read-only analysis', () => {
  for (const harness of ['pi', 'opencode'] as const) {
    it(harness + ' runs a real prompt when no trusted optional dependencies can be discovered', async () => {
      const fixture = await createBundleFixture(); const server = await model();
      try {
        const parsed = parseReviewEnvironment({ ...cleanReviewEnvironment(fixture, harness),
          REDLINE_MODEL_CONFIG: JSON.stringify({ provider: 'mock', endpoint: `http://127.0.0.1:${server.port}/v1`, model: 'test-model' }),
          REDLINE_MODEL_AUTH: JSON.stringify({ mock: key }), REDLINE_TIMEOUT: '1m' });
        if (parsed.review === undefined) throw new Error('fixture review configuration missing');
        // Reject every optional package path without changing any installation or global config.
        const result = await runFileReviews({ environment: parsed.review, repositoryDirectory: process.platform === 'win32' ? 'C:\\\\' : '/' });
        expect(result.records[0]?.outcome, result.records[0]?.reason).toBe('findings');
        expect(server.requests).toHaveLength(1);
        const report = JSON.parse(await readFile(join(fixture.output, 'reviews/analysis-tools.json'), 'utf8'));
        expect(report.integrations.every((row: {status:string}) => row.status !== 'ready')).toBe(true);
        expect(report.integrations.some((row: {status:string}) => row.status === 'missing')).toBe(true);
      } finally { await server.close(); await fixture.cleanup(); }
    }, 50_000);
    it(harness + ' indexes captured source, searches it, denies outside paths and still returns validated findings', async () => {
      const fixture = await createBundleFixture(); const server = await model();
      try {
        const parsed = parseReviewEnvironment({ ...cleanReviewEnvironment(fixture, harness),
          REDLINE_MODEL_CONFIG: JSON.stringify({ provider: 'mock', endpoint: `http://127.0.0.1:${server.port}/v1`, model: 'test-model' }),
          REDLINE_MODEL_AUTH: JSON.stringify({ mock: key }), REDLINE_TIMEOUT: '1m', REDLINE_RUN_TIMEOUT: '2m' });
        if (parsed.review === undefined) throw new Error('fixture review configuration missing');
        const result = await runFileReviews({ environment: parsed.review });
        expect(result.records[0]?.outcome, result.records[0]?.reason).toBe('findings');
        expect(result.records[0]?.findings[0]?.evidence).toBe('new');
        expect(server.requests).toHaveLength(4);
        expect(server.requests.every(request => request.authorization === 'Bearer ' + key)).toBe(true);
        const names = server.requests[0]!.body.tools?.map(tool => tool.function.name) ?? [];
        expect(names).toHaveLength(3);
        expect(names.some(name => name.endsWith('ctx_index'))).toBe(true);
        expect(names.some(name => name.endsWith('ctx_search'))).toBe(true);
        expect(names.some(name => name.endsWith('sequentialthinking'))).toBe(true);
        const toolResults = server.requests[3]!.body.messages?.filter(message => message.role === 'tool') ?? [];
        expect(toolResults).toHaveLength(3);
        expect(JSON.stringify(toolResults)).toContain('new');
        expect(JSON.stringify(toolResults)).toContain('denied');
        const report = await readFile(join(fixture.output, 'reviews/analysis-tools.json'), 'utf8');
        const statuses = JSON.parse(report).integrations as { component: string; status: string }[];
        expect(statuses.find(row => row.component === 'context-mode')?.status).toBe('ready');
        expect(statuses.find(row => row.component === 'sequential-thinking')?.status).toBe('ready');
        expect(report + JSON.stringify(result)).not.toContain(key);
      } finally { await server.close(); await fixture.cleanup(); }
    }, 80_000);
  }
});
