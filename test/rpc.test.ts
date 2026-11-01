import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLocalOptions } from '../src/local/options.ts';
import { runLocalReview } from '../src/local/run.ts';
import { RpcClient } from './helpers/rpc-client.ts';
import { CODES, object } from '../src/rpc/contract.ts';
import { frame } from '../src/rpc/framing.ts';
import { reviewFinding } from './helpers/finding.ts';

const binary = fileURLToPath(new URL('../bin/redline.mjs', import.meta.url));
const roots: string[] = []; const clients: RpcClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'redline-rpc-')); roots.push(root);
  const repository = join(root, 'repo'); await mkdir(repository);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root,
    TMP: root, TEMP: root, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '--quiet', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'RPC fixture'); git('config', 'user.email', 'rpc@example.invalid');
  await writeFile(join(repository, 'example.ts'), 'export const value = 1;\n'); git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'example.ts'), 'export const value = 2;\n'); git('commit', '--quiet', '-am', 'head');
  const start = (once = false, args = ['--harness', 'echo', '--indexing', 'disabled', '--reuse', 'disabled']) => {
    const client = new RpcClient(binary, [...(once ? ['--once'] : []), ...args], env, root); clients.push(client); return client;
  };
  return { root, repository, env, git, base, start };
}
function items(result: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(result.items) || result.items.some(value => !object(value))) throw new Error('Invalid page');
  return result.items;
}
function directory(run: Record<string, unknown>): string {
  if (!object(run.artifacts) || typeof run.artifacts.directory !== 'string') throw new Error('Missing artifact references');
  return run.artifacts.directory;
}

describe('real stdio reference-client conformance', () => {
  it.each([true, false])('passes the same corpus and review/result contract in once=%s mode', async once => {
    const f = await fixture(); const client = f.start(once);
    const initialized = await client.call('initialize', { protocolVersion: '1.0', optionalCapabilities: ['progress', 'future-optional'] });
    expect(initialized.protocolVersion).toBe('1.0');
    const corpus: { method: string; params: Record<string, unknown>; code: number }[] = JSON.parse(await readFile(new URL('./fixtures/rpc/conformance.json', import.meta.url), 'utf8'));
    for (const item of corpus) await expect(client.call(item.method, item.params)).rejects.toMatchObject({ code: item.code });
    const before = f.git('status', '--porcelain=v1'); const index = await readFile(join(f.repository, '.git/index'));
    const job = await client.call('review.start', { repository: f.repository, base: f.base, head: 'HEAD' });
    const runId = String(job.runId); const terminal = await client.wait(runId);
    expect(terminal.state).toBe('completed'); expect(terminal.exitCode).toBe(0); expect(terminal.resultAvailable).toBe(true);
    const overview = items(await client.call('review.result', { runId }))[0];
    expect(overview?.findings).toBe(0);
    const files = items(await client.call('review.result', { runId, section: 'files', limit: 1 }));
    expect(files).toHaveLength(1); expect(files[0]?.path).toBe('example.ts');
    expect(items(await client.call('review.result', { runId, section: 'findings' }))).toEqual([]);
    expect(items(await client.call('review.result', { runId, section: 'files', offset: 1 }))).toEqual([]);
    expect(await readFile(join(directory(terminal), 'reviews/review.md'), 'utf8')).toContain('#');
    expect((await client.call('review.get', { runId })).state).toBe('completed');
    expect((await client.call('review.cancel', { runId })).state).toBe('completed');
    expect(f.git('status', '--porcelain=v1')).toBe(before); expect(await readFile(join(f.repository, '.git/index'))).toEqual(index);
    if (once) await expect(client.call('review.start', { repository: f.repository })).rejects.toMatchObject({ code: CODES.busy });
    else {
      await writeFile(join(f.repository, 'example.ts'), 'export const value = 3;\n');
      const second = await client.call('review.start', { repository: f.repository, worktree: 'all' });
      expect((await client.wait(String(second.runId))).state).toBe('completed');
    }
    await client.call('shutdown'); client.eof();
    expect((await client.exit).code).toBe(0);
    // Some supported Node 24 releases warn about their own TypeScript stripping API.
    expect(client.stderr.replace(/^\(node:\d+\) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time\r?\n\(Use .*--trace-warnings.*\)\r?\n/gu, '')).toBe('');
  });
  it('drains accepted one-shot work after early EOF', async () => {
    const f = await fixture(); const client = f.start(true);
    await client.call('initialize', { protocolVersion: '1.0' });
    const job = await client.call('review.start', { repository: f.repository, base: f.base, head: 'HEAD' });
    client.eof(); const terminal = await client.wait(String(job.runId));
    expect(terminal.state).toBe('completed'); expect((await client.exit).code).toBe(0);
  });
  it('reports revision and configuration errors without exposing raw values', async () => {
    const f = await fixture(); const client = f.start();
    await client.call('initialize', { protocolVersion: '1.0' });
    const job = await client.call('review.start', { repository: join(f.root, 'missing-PRIVATE_VALUE') });
    const terminal = await client.wait(String(job.runId));
    expect(terminal.state).toBe('failed'); expect(terminal.error).toMatchObject({ code: CODES.revision });
    expect(JSON.stringify(client.messages)).not.toContain('PRIVATE_VALUE');
    await client.call('shutdown'); client.eof(); expect((await client.exit).code).toBe(0);
  });
  it('classifies a missing trusted harness as configuration before creating output', async () => {
    const f = await fixture();
    const options = await parseLocalOptions(['--repository', f.repository, '--harness', 'pi', '--provider', 'mock',
      '--endpoint', 'http://127.0.0.1:1/v1', '--model', 'fixture', '--auth', 'none', '--indexing', 'disabled', '--reuse', 'disabled'], f.env, f.root);
    const reporter = vi.fn(() => { throw new Error('Preflight must precede reporting'); });
    const outcome = await runLocalReview(options, { ...f.env, PATH: '' }, {
      signal: new AbortController().signal, reporter, stdout: () => {}, stderr: () => {},
    });
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'configuration' });
    expect(outcome.outputDirectory).toBeUndefined(); expect(reporter).not.toHaveBeenCalled();
    expect(await stat(join(f.root, 'state')).then(() => true, () => false)).toBe(false);
  });
  it.each(['request', 'output-close'])('cancels a real owned harness process via %s and preserves terminal artifacts', async mode => {
    const f = await fixture(); const bin = join(f.root, 'bin'); await mkdir(bin);
    const pidFile = join(f.root, 'pid'); const secret = 'rpc-private!key*value';
    await writeFile(join(bin, 'pi'), '#!/usr/bin/env node\n' +
      'import fs from "node:fs";if(process.argv.includes("--version")){console.log("1.4.0");process.exit(0);}' +
      'fs.writeFileSync(' + JSON.stringify(pidFile) + ',String(process.pid));setInterval(()=>{},1000);', { mode: 0o755 });
    f.env.PATH = bin + delimiter + (f.env.PATH ?? '');
    f.env.REDLINE_MODEL_CONFIG = JSON.stringify({ provider: 'mock', endpoint: 'http://127.0.0.1:1/v1', model: 'fixture' });
    f.env.REDLINE_MODEL_AUTH = JSON.stringify({ mock: secret });
    const client = f.start(false, ['--harness', 'pi', '--indexing', 'disabled', '--reuse', 'disabled', '--retries', '0']);
    await client.call('initialize', { protocolVersion: '1.0' });
    const job = await client.call('review.start', { repository: f.repository, base: f.base, head: 'HEAD' });
    const deadline = Date.now() + 10_000;
    while (!await stat(pidFile).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error('Owned harness did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const pid = Number(await readFile(pidFile, 'utf8'));
    let stopped = false; let watchdogFired = false; let timer: NodeJS.Timeout | undefined;
    try {
      let output: string;
      if (mode === 'request') {
        await client.call('review.cancel', { runId: job.runId });
        const terminal = await client.wait(String(job.runId));
        expect(terminal.state).toBe('cancelled'); expect(terminal.exitCode).toBe(130);
        output = directory(terminal);
      } else {
        output = directory(await client.call('review.get', { runId: job.runId }));
        const closed = new Promise<void>(resolve => client.child.stdout.once('close', () => resolve()));
        client.child.stdout.destroy(); await closed;
        client.child.stdin.write(frame({ jsonrpc: '2.0', id: 900, method: 'redline/v1/review.get', params: { runId: job.runId } }));
        timer = setTimeout(() => { watchdogFired = true; client.child.kill('SIGKILL'); }, 10_000);
        const exit = await client.exit;
        expect(watchdogFired, client.stderr).toBe(false);
        expect(exit.code !== 0 || exit.signal !== null).toBe(true);
        expect(client.stderr).toContain('redline rpc: output unavailable');
        expect(client.stderr).not.toMatch(/Unhandled|unhandled|node:events/gu);
      }
      expect(() => process.kill(pid, 0)).toThrow(); stopped = true;
      expect(JSON.parse(await readFile(join(output, 'status.json'), 'utf8')).status).toBe('cancelled');
      expect(JSON.stringify(client.messages)).not.toContain(secret);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // The fixture owns this exact synthetic harness PID, including on assertion failure.
      if (!stopped) try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped by normal cancellation. */ }
    }
  });
  it('treats auth as the non-secret none mode, never a credential argument', async () => {
    const f = await fixture();
    const client = f.start(false, ['--harness', 'echo', '--auth', 'SYNTHETIC_NOT_AN_AUTH_MODE', '--indexing', 'disabled']);
    await client.call('initialize', { protocolVersion: '1.0' });
    const job = await client.call('review.start', { repository: f.repository });
    expect(await client.wait(String(job.runId))).toMatchObject({ state: 'failed', error: { code: CODES.configuration }, artifacts: null });
    expect(JSON.stringify(client.messages)).not.toContain('SYNTHETIC_NOT_AN_AUTH_MODE');
  });
  it('projects validated findings, source evidence, suggestions and deterministic fix prompts', async () => {
    const f = await fixture(); const bin = join(f.root, 'bin'); await mkdir(bin);
    const finding = reviewFinding({ evidence: 'export const value = 2;', suggestedChange: 'export const value = 3;' });
    const answer = JSON.stringify({ version: 4, fileId: '000001', outcome: 'findings', findings: [finding], contextRequests: [] });
    await writeFile(join(bin, 'pi'), '#!/usr/bin/env node\n' +
      'console.log(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"thinking_delta",delta:"PRIVATE_RAW_MARKER"}}));' +
      'console.log(JSON.stringify({type:"turn_end",message:{role:"assistant",content:[{type:"text",text:' + JSON.stringify(answer) + '}],stopReason:"stop"}}));', { mode: 0o755 });
    f.env.PATH = bin + delimiter + (f.env.PATH ?? '');
    f.env.REDLINE_MODEL_CONFIG = JSON.stringify({ provider: 'mock', endpoint: 'http://127.0.0.1:1/v1', model: 'fixture' });
    f.env.REDLINE_MODEL_AUTH = JSON.stringify({ mock: 'synthetic-rpc-key' });
    const client = f.start(false, ['--harness', 'pi', '--indexing', 'disabled', '--reuse', 'disabled', '--retries', '0']);
    await client.call('initialize', { protocolVersion: '1.0' });
    const job = await client.call('review.start', { repository: f.repository, base: f.base, head: 'HEAD' });
    expect((await client.wait(String(job.runId))).state).toBe('completed');
    const results = items(await client.call('review.result', { runId: job.runId, section: 'findings' }));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ path: 'example.ts', side: 'RIGHT', startLine: 1, endLine: 1, evidence: 'export const value = 2;' });
    expect(results[0]?.verification).toMatchObject({ status: 'unverified' });
    expect(results[0]?.remediationStatus).toBe('guidance');
    expect(results[0]?.suggestion).toContain('export const value = 3;'); expect(results[0]?.fixPrompt).toBeTruthy();
    expect(JSON.stringify(client.messages)).not.toContain('PRIVATE_RAW_MARKER');
    expect(JSON.stringify(client.messages)).not.toContain('synthetic-rpc-key');
  });
});
