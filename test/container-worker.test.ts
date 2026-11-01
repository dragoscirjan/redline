import { spawn, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DockerClient, containerArguments, DEFAULT_CONTAINER_LIMITS } from '../src/harness-worker/docker-client.ts';
import { loadWorkerImage, parseWorkerManifest, type WorkerImage } from '../src/harness-worker/images.ts';
import { executable } from '../src/local/process.ts';
import { RpcClient } from './helpers/rpc-client.ts';

const enabled = process.env.REDLINE_CONTAINER_TESTS === '1';
const manifest = process.env.REDLINE_WORKER_MANIFEST;
const binary = process.env.REDLINE_CONTAINER_CLI ?? fileURLToPath(new URL('../bin/redline.mjs', import.meta.url));
const roots: string[] = []; const servers: Server[] = [];
const key = 'synthetic-container-model-key-do-not-persist';
function deferred() {
  let done: (() => void) | undefined; let fail: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  return { promise, resolve() { if (done === undefined) throw new Error('Uninitialized deferred'); done(); },
    reject(error: Error) { if (fail === undefined) throw new Error('Uninitialized deferred'); fail(error); } };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(mode: 'finding' | 'busy' | 'unauthorized' | 'hang' = 'finding') {
  const firstRequest = deferred();
  const root = await mkdtemp(join(tmpdir(), 'redline-container-test-')); roots.push(root);
  const repository = join(root, 'repository'); await mkdir(join(repository, 'src'), { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { env, encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main'); git('config', 'user.name', 'Container fixture'); git('config', 'user.email', 'container@example.invalid'); git('config', 'core.autocrlf', 'false');
  await writeFile(join(repository, 'src/example.ts'), 'old\n'); git('add', '.'); git('commit', '--quiet', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'src/example.ts'), 'new\n'); git('commit', '--quiet', '-am', 'head');
  const requests: { path: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += String(part);
    const body: Record<string, unknown> = JSON.parse(raw || '{}');
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body }); firstRequest.resolve();
    if (mode === 'hang') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting for cancellation\n\n'); return; }
    if (mode === 'busy' || mode === 'unauthorized') {
      res.writeHead(mode === 'busy' ? 503 : 401, { 'content-type': 'application/json', 'retry-after-ms': '1', 'retry-after': '0' });
      const text = JSON.stringify({ error: { message: mode === 'busy' ? 'Service temporarily unavailable' : 'Invalid API key ' + key, type: mode === 'busy' ? 'server_error' : 'authentication_error' } });
      for (let offset = 0; offset < text.length; offset += 8) res.write(text.slice(offset, offset + 8)); res.end(); return;
    }
    const fileId = /\\?"fileId\\?"\s*:\s*\\?"(\d{6})\\?"/u.exec(raw)?.[1] ?? '000001';
    const reply = JSON.stringify({ version: 4, fileId, outcome: 'findings', reason: 'Scripted supported defect.', contextRequests: [], findings: [{
      title: 'Fixture contract changed', dimensions: ['correctness'],
      category: 'correctness', classification: 'defect', severity: 'high', confidence: 0.9, side: 'RIGHT', startLine: 1, endLine: 1,
      evidence: 'new', supportingEvidence: [], graphReferences: [],
      impactPath: { status: 'partial', steps: [], limitation: 'This deterministic fixture uses file-only evidence.' },
      behavioralContract: 'The fixture requires old.', failureScenario: 'The changed value is new.', reachability: 'The changed line is the fixture entry.',
      rootCause: 'The changed value no longer matches the contract.', impact: 'The new line violates the fixture contract.', blastRadius: 'One fixture line.',
      reversibility: 'reversible', assumptions: [], counterEvidence: [], uncertainty: 'No extra context is available in this fixture.',
      fix: 'Restore old.', regressionTest: 'Assert the fixture retains old.', verification: { status: 'unverified', reason: 'Scripted integration fixture.' },
      remediationStatus: 'proposed', suggestedChange: 'old',
    }] });
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < reply.length; i += 32) res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'test-model',
        choices: [{ index: 0, delta: { content: reply.slice(i, i + 32) }, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Fixture address unavailable');
  return { root, repository, env, git, base, requests, firstRequest: firstRequest.promise, endpoint: `http://127.0.0.1:${address.port}/v1` };
}
function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let bytes = 0;
    for (const [stream, collect] of [[child.stdout, (s: string) => { stdout += s; }], [child.stderr, (s: string) => { stderr += s; }]] as const) {
      stream.on('data', (part: Buffer) => { bytes += part.length; if (bytes > 8 * 1024 * 1024) child.kill('SIGKILL'); else collect(part.toString()); });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe.runIf(enabled)('real isolated Pi/OpenCode workers', () => {
  for (const harness of ['pi', 'opencode'] as const) {
    it(`${harness} reviews through the host broker without changing Git state or persisting its real credential`, async () => {
      const f = await fixture(); const output = join(f.root, 'output');
      const before = f.git('status', '--porcelain=v1');
      const result = await cli(['review', '--repository', f.repository, '--base', f.base, '--head', 'HEAD', '--indexing', 'disabled', '--reuse', 'disabled',
        '--harness', harness, '--isolation', 'docker', ...(manifest === undefined ? [] : ['--worker-manifest', manifest]),
        '--provider', 'mock', '--endpoint', f.endpoint, '--model', 'test-model', '--max-output-tokens', '4096', '--retries', '0', '--output', output],
      { ...f.env, REDLINE_MODEL_AUTH: JSON.stringify({ mock: key }) });
      const failureRecord = result.code === 0 ? '' : await readFile(join(output, 'reviews/000001.json'), 'utf8').catch(() => 'no file record');
      expect(result.code, result.stdout + '\n' + result.stderr + '\n' + failureRecord.slice(0,6000)).toBe(0);
      const summary = JSON.parse(await readFile(join(output, 'reviews/summary.json'), 'utf8'));
      const record = JSON.parse(await readFile(join(output, 'reviews/000001.json'), 'utf8'));
      expect(summary.omittedFiles).toBe(0); expect(record.outcome).toBe('findings');
      expect(record.findings[0]).toMatchObject({ evidence: 'new', side: 'RIGHT', startLine: 1, endLine: 1 });
      expect(record.findings[0].suggestion).toBe('-new\n+old'); expect(record.findings[0].fixPrompt).toContain('Fix one code-review finding.');
      expect(JSON.stringify(record) + result.stdout + result.stderr).not.toContain(key);
      expect(f.requests).toHaveLength(1); expect(f.requests[0]?.authorization).toBe('Bearer ' + key);
      expect(f.requests[0]?.body.model).toBe('test-model'); expect(f.git('status', '--porcelain=v1')).toBe(before);
    }, 120_000);
    it(`${harness} uses the same isolated executor through RPC and rejects request-selected isolation`, async () => {
      const f = await fixture();
      const client = new RpcClient(binary, ['--harness', harness, '--isolation', 'docker', ...(manifest === undefined ? [] : ['--worker-manifest', manifest]),
        '--provider', 'mock', '--endpoint', f.endpoint, '--model', 'test-model', '--max-output-tokens', '4096', '--retries', '0', '--indexing', 'disabled', '--reuse', 'disabled'],
      { ...f.env, REDLINE_MODEL_AUTH: JSON.stringify({ mock: key }) }, f.root);
      try {
        await client.call('initialize', { protocolVersion: '1.0' });
        await expect(client.call('review.start', { repository: f.repository, base: f.base, head: 'HEAD', isolation: 'direct' })).rejects.toMatchObject({ code: -32602 });
        expect(f.requests).toHaveLength(0);
        const run = await client.call('review.start', { repository: f.repository, base: f.base, head: 'HEAD' });
        expect((await client.wait(String(run.runId))).state).toBe('completed');
        const result = await client.call('review.result', { runId: run.runId, section: 'files' });
        expect(result.items).toMatchObject([{ path: 'src/example.ts', outcome: 'findings' }]);
        expect(JSON.stringify(result) + JSON.stringify(client.messages) + client.stderr).not.toContain(key);
        expect(f.requests).toHaveLength(1); expect(f.requests[0]?.authorization).toBe('Bearer ' + key);
        await client.call('shutdown'); client.eof(); expect((await client.exit).code).toBe(0);
      } finally { await client.close(); }
    }, 120_000);
  }
  for (const harness of ['pi', 'opencode'] as const) {
    it(`${harness} preserves native retry ownership inside fresh outer invocations`, async () => {
      const f = await fixture('busy');
      const result = await cli(['review', '--repository', f.repository, '--base', f.base, '--head', 'HEAD', '--indexing', 'disabled', '--reuse', 'disabled',
        '--harness', harness, '--isolation', 'docker', ...(manifest === undefined ? [] : ['--worker-manifest', manifest]), '--provider', 'mock', '--endpoint', f.endpoint,
        '--model', 'test-model', '--max-output-tokens', '4096', '--retries', '1', '--timeout', '1m', '--run-timeout', '2m'], { ...f.env, REDLINE_MODEL_AUTH: JSON.stringify({ mock: key }) });
      expect(result.code, result.stdout + result.stderr).toBe(1);
      expect(f.requests).toHaveLength(harness === 'pi' ? 2 : 12);
      expect(result.stdout + result.stderr).not.toContain(key);
    }, 120_000);
    it(`${harness} treats authentication failure as nonretryable and redacts reflected credentials before worker output`, async () => {
      const f = await fixture('unauthorized');
      const result = await cli(['review', '--repository', f.repository, '--base', f.base, '--head', 'HEAD', '--indexing', 'disabled', '--reuse', 'disabled',
        '--harness', harness, '--isolation', 'docker', ...(manifest === undefined ? [] : ['--worker-manifest', manifest]), '--provider', 'mock', '--endpoint', f.endpoint,
        '--model', 'test-model', '--max-output-tokens', '4096', '--retries', '3'], { ...f.env, REDLINE_MODEL_AUTH: JSON.stringify({ mock: key }) });
      expect(result.code, result.stdout + result.stderr).toBe(1); expect(f.requests).toHaveLength(1); expect(result.stdout + result.stderr).not.toContain(key);
    }, 120_000);
    it(`${harness} cancels an active isolated model stream through RPC`, async () => {
      const f = await fixture('hang');
      const client = new RpcClient(binary, ['--harness', harness, '--isolation', 'docker', ...(manifest === undefined ? [] : ['--worker-manifest', manifest]),
        '--provider', 'mock', '--endpoint', f.endpoint, '--model', 'test-model', '--max-output-tokens', '4096', '--retries', '0', '--indexing', 'disabled', '--reuse', 'disabled'],
      { ...f.env, REDLINE_MODEL_AUTH: JSON.stringify({ mock: key }) }, f.root);
      try {
        await client.call('initialize', { protocolVersion: '1.0' });
        const run = await client.call('review.start', { repository: f.repository, base: f.base, head: 'HEAD' });
        const missing = deferred();
        const deadline = setTimeout(() => missing.reject(new Error('Model request did not start')), 10_000);
        try { await Promise.race([f.firstRequest, missing.promise]); } finally { clearTimeout(deadline); }
        await client.call('review.cancel', { runId: run.runId });
        expect((await client.wait(String(run.runId))).state).toBe('cancelled'); expect(f.requests).toHaveLength(1);
        await client.call('shutdown'); client.eof(); expect((await client.exit).code).toBe(0);
      } finally { await client.close(); }
    }, 120_000);
  }
  it('enforces the same kernel, filesystem, environment and network profile without host mounts', async () => {
    const f = await fixture(); const marker = join(f.root, 'host-only-marker'); await writeFile(marker, 'host-only');
    const command = await executable('docker', process.env.PATH ?? '', f.repository);
    let image: WorkerImage;
    if (manifest === undefined && process.env.REDLINE_CONTAINER_CLI !== undefined) {
      const packageRoot = dirname(dirname(binary));
      const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      const data = parseWorkerManifest(JSON.parse(await readFile(join(packageRoot, 'src/harness-worker/worker-images.json'), 'utf8')), pkg.version, false);
      image = { ...data.images.pi, development: false, identity: { harness: 'pi', release: data.release, revision: data.revision, harnessVersion: data.images.pi.harnessVersion } };
    } else image = await loadWorkerImage('pi', f.repository, manifest);
    const client = await DockerClient.create(command, f.repository, f.root, f.env);
    const jobId = randomUUID(); const signal = AbortSignal.timeout(30_000); let id: string | undefined;
    try {
      await client.preflight(image, signal);
      const args = containerArguments(image, client.owner, jobId, 30_000, DEFAULT_CONTAINER_LIMITS);
      args.splice(args.length - 1, 0, '--entrypoint', 'node');
      args.push('-e', `const fs=require('node:fs'),os=require('node:os');const root=fs.readFileSync('/proc/self/mountinfo','utf8').split('\\n').find(l=>l.split(' ')[4]==='/');console.log(JSON.stringify({uid:process.getuid(),status:fs.readFileSync('/proc/self/status','utf8'),root,interfaces:Object.keys(os.networkInterfaces()),socket:fs.existsSync('/var/run/docker.sock'),marker:fs.existsSync(${JSON.stringify(marker)}),credential:process.env.REDLINE_MODEL_AUTH??null,memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()}));`);
      id = await client.run(args, signal); const data = JSON.parse(await client.run(['start', '--attach', id], signal));
      expect(data.uid).toBe(10001); expect(data.status).toMatch(/NoNewPrivs:\s+1/u); expect(data.status).toMatch(/Seccomp:\s+2/u); expect(data.status).toMatch(/CapEff:\s+0+\n/u);
      expect(data.root.split(' ')[5].split(',')).toContain('ro'); expect(data.interfaces).toEqual(['lo']);
      expect(data.socket).toBe(false); expect(data.marker).toBe(false); expect(data.credential).toBeNull();
      expect(data.memory).toBe(String(1024 * 1024 * 1024)); expect(data.pids).toBe('128');
    } finally { if (id !== undefined) await client.remove(id, jobId); await client.close(); }
  }, 60_000);
});
