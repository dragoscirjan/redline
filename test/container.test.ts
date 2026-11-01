import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcClient } from './helpers/rpc-client.ts';

const enabled = process.env.REDLINE_CONTAINER_TESTS === '1';
const roots: string[] = [];
const containers: { name: string; env: NodeJS.ProcessEnv }[] = [];
const children: ChildProcess[] = [];
const key = 'synthetic-container-model-key-do-not-persist';
function image(): string {
  const value = process.env.REDLINE_CONTAINER_IMAGE;
  if (value === undefined) throw new Error('Set REDLINE_CONTAINER_IMAGE to test the Redline image');
  return value;
}
function docker(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('docker', args, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }).trim();
}
function named(env: NodeJS.ProcessEnv): string {
  const name = 'redline-test-' + randomUUID(); containers.push({ name, env }); return name;
}
afterEach(async () => {
  for (const item of containers.splice(0)) {
    try { docker(['rm', '--force', '--volumes', item.name], item.env); } catch { /* --rm may already have removed it. */ }
  }
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'redline-image-test-')); roots.push(root);
  const config = join(root, 'docker'); await mkdir(config);
  await writeFile(join(config, 'config.json'), '{"auths":{}}\n', { mode: 0o600 });
  return { root, env: { PATH: process.env.PATH, HOME: root, DOCKER_CONFIG: config, LANG: 'C.UTF-8' } };
}
const profile = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g',
  '--pids-limit', '256', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777'];
async function fixture(mode = 'finding') {
  const { root, env } = await environment();
  const repository = join(root, 'repository'), output = join(root, 'output');
  const cache = process.env.REDLINE_CONTAINER_CACHE ?? join(root, 'cache');
  await Promise.all([mkdir(repository), mkdir(output), mkdir(cache, { recursive: true, mode: 0o700 })]);
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgSign=false', ...args], { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main'); git('config', 'user.name', 'Image fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await mkdir(join(repository, 'src')); await writeFile(join(repository, 'src/example.ts'), 'old\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'src/example.ts'), 'new\n'); git('commit', '--quiet', '-am', 'head');
  const model = named(env);
  docker(['run', '--detach', '--name', model, ...profile, '--env', 'REDLINE_MOCK_MODE=' + mode, '--entrypoint', 'node',
    image(), '--input-type=module', '-e', await readFile(new URL('./fixtures/container-model.mjs', import.meta.url), 'utf8')], env);
  const requests: { authorization?: string; body: Record<string, unknown> }[] = [];
  let readyDone: (() => void) | undefined, requested: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { readyDone = resolve; });
  const firstRequest = new Promise<void>(resolve => { requested = resolve; });
  const logs = spawn('docker', ['logs', '--follow', model], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(logs);
  let pending = '', bytes = 0;
  logs.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { logs.kill(); return; }
    pending += chunk.toString();
    for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) break;
      const value = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (value.type === 'ready') readyDone?.();
      if (value.type === 'request') { requests.push(value); requested?.(); }
    }
  });
  logs.stderr.resume();
  const timer = setTimeout(() => logs.kill(), 10_000);
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => logs.once('close', () => reject(new Error('Synthetic model failed to start'))))]);
  } finally { clearTimeout(timer); }
  const address = docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', model], env);
  const common = ['--repository', '/repository', '--base', base, '--head', 'HEAD', '--indexing', 'disabled', '--reuse', 'disabled',
    '--provider', 'mock', '--endpoint', 'http://' + address + ':3000/v1', '--model', 'test-model', '--max-output-tokens', '4096', '--retries', '0'];
  function runArgs() {
    return ['run', '--rm', '--name', named(env), ...profile, '--user', String(process.getuid?.() ?? 10001) + ':' + String(process.getgid?.() ?? 10001),
      '--mount', 'type=bind,src=' + repository + ',dst=/repository,readonly',
      '--mount', 'type=bind,src=' + output + ',dst=/output',
      '--mount', 'type=bind,src=' + cache + ',dst=/cache',
      '--env', 'REDLINE_MODEL_AUTH=' + JSON.stringify({ mock: key }), image()];
  }
  return { root, env, repository, output, cache, git, base, common, runArgs, firstRequest,
    get requests() { return docker(['logs', model], env).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(value => value.type === 'request') as typeof requests; } };
}
function run(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    let stdout = '', stderr = '', bytes = 0;
    for (const [stream, collect] of [[child.stdout, (s: string) => { stdout += s; }], [child.stderr, (s: string) => { stderr += s; }]] as const) {
      stream.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 8 * 1024 * 1024) child.kill(); else collect(data.toString()); });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe.runIf(enabled)('Redline runs inside Docker', () => {
  it('starts the Redline CLI as its default entrypoint', async () => {
    const { env } = await environment();
    const result = await run(['run', '--rm', ...profile, image(), '--help'], env);
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain('Usage: redline review');
    expect(result.stdout).not.toContain('--isolation'); expect(result.stdout).not.toContain('--container-image');
  }, 40_000);
  for (const harness of ['pi', 'opencode'] as const) {
    it(`${harness} reviews a read-only repository with the controller inside the image`, async () => {
      const f = await fixture(); const before = f.git('status', '--porcelain=v1');
      const result = await run([...f.runArgs(), 'review', ...f.common, '--harness', harness, '--output', '/output/run'], f.env);
      const record = JSON.parse(await readFile(join(f.output, 'run/reviews/000001.json'), 'utf8').catch(() => '{}'));
      expect(result.code, result.stdout + result.stderr + JSON.stringify(record)).toBe(0);
      expect(record).toMatchObject({ outcome: 'findings', findings: [{ evidence: 'new', side: 'RIGHT', startLine: 1, endLine: 1 }] });
      expect(record.findings[0].suggestion).toBe('-new\n+old');
      expect(JSON.stringify(record) + result.stdout + result.stderr).not.toContain(key);
      expect(f.requests).toHaveLength(1); expect(f.requests[0]?.authorization).toBe('Bearer ' + key);
      expect(f.git('status', '--porcelain=v1')).toBe(before);
    }, 50_000);
    it(`${harness} serves RPC from the image`, async () => {
      const f = await fixture(); const args = f.common.slice(6); // RPC startup excludes repository/base/head selections.
      const launch = f.runArgs(); launch.splice(1, 0, '--interactive');
      const client = new RpcClient('', ['--harness', harness, ...args], f.env, f.root,
        { command: 'docker', args: launch });
      try {
        await client.call('initialize', { protocolVersion: '1.0' });
        const review = await client.call('review.start', { repository: '/repository', base: f.base, head: 'HEAD' });
        expect((await client.wait(String(review.runId))).state, client.stderr).toBe('completed');
        const result = await client.call('review.result', { runId: review.runId, section: 'files' });
        expect(result.items).toMatchObject([{ path: 'src/example.ts', outcome: 'findings' }]);
        expect(JSON.stringify(result) + client.stderr).not.toContain(key);
        await client.call('shutdown'); client.eof(); expect((await client.exit).code).toBe(0);
      } finally { await client.close(); }
    }, 50_000);
    it(`${harness} retains native retry counts inside Redline's container`, async () => {
      const f = await fixture('busy');
      const args = f.common.filter((_, i, all) => all[i - 1] !== '--retries' && all[i] !== '--retries');
      const result = await run([...f.runArgs(), 'review', ...args, '--harness', harness, '--retries', '1'], f.env);
      expect(result.code, result.stderr).toBe(1); expect(f.requests).toHaveLength(harness === 'pi' ? 2 : 12);
    }, 50_000);
    it(`${harness} cancels the native SDK through containerized RPC`, async () => {
      const f = await fixture('hang'); const launch = f.runArgs(); launch.splice(1, 0, '--interactive');
      const client = new RpcClient('', ['--harness', harness, ...f.common.slice(6)], f.env, f.root, { command: 'docker', args: launch });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await client.call('initialize', { protocolVersion: '1.0' });
        const review = await client.call('review.start', { repository: '/repository', base: f.base, head: 'HEAD' });
        await Promise.race([f.firstRequest, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Model request did not start')), 10_000); })]);
        clearTimeout(timer);
        await client.call('review.cancel', { runId: review.runId });
        expect((await client.wait(String(review.runId))).state).toBe('cancelled');
        expect(f.requests).toHaveLength(1);
        await client.call('shutdown'); client.eof(); expect((await client.exit).code).toBe(0);
      } finally { clearTimeout(timer); await client.close(); }
    }, 50_000);
    it(`${harness} redacts a reflected fake key without retrying authentication failures`, async () => {
      const f = await fixture('unauthorized');
      const result = await run([...f.runArgs(), 'review', ...f.common, '--harness', harness], f.env);
      expect(result.code, result.stderr).toBe(1); expect(f.requests).toHaveLength(1);
      expect(result.stdout + result.stderr).not.toContain(key);
    }, 50_000);
  }
  for (const provider of ['cgc', 'gitnexus']) it(`${provider} retains its index cache across Redline containers`, async () => {
    const f = await fixture();
    const args = f.common.map((value, index, all) => all[index - 1] === '--indexing' ? 'enabled' : value);
    for (const output of ['first', 'second']) {
      const result = await run([...f.runArgs(), 'review', ...args, '--harness', 'echo', '--indexing-provider', provider, '--output', '/output/' + output], f.env, 90_000);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      if (output === 'second') expect(result.stderr, result.stdout + result.stderr).toContain('Base index: reused');
    }
  }, 180_000);
  it('starts installed MCP servers without network or a writable root', async () => {
    const { env } = await environment();
    const raw = docker(['run', '--rm', ...profile, '--network', 'none', '--entrypoint', 'node', image(), '--input-type=module', '-e',
      await readFile(new URL('./fixtures/container-mcp.mjs', import.meta.url), 'utf8')], env);
    const results = JSON.parse(raw);
    for (const name of ['cgc', 'gitnexus', 'context-mode', 'sequential-thinking']) {
      expect(results.find((r: { name: string }) => r.name === name)).toHaveProperty('tools');
    }
  }, 40_000);
  it('retains bounded diagnostics when an installed MCP server fails to start', async () => {
    const { root, env } = await environment();
    const script = join(root, 'failed-server.mjs');
    await writeFile(script, "process.stderr.write('x'.repeat(20000) + ' expected-startup-failure', () => process.exit(1));");
    const raw = docker(['run', '--rm', ...profile, '--network', 'none',
      '--mount', 'type=bind,src=' + script + ',dst=/opt/harness/node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js,readonly',
      '--entrypoint', 'node', image(), '--input-type=module', '-e',
      await readFile(new URL('./fixtures/container-mcp.mjs', import.meta.url), 'utf8')], env);
    const result = JSON.parse(raw).find((item: { name: string }) => item.name === 'sequential-thinking');
    expect(result).toHaveProperty('error');
    expect(result.stderr).toContain('expected-startup-failure');
    expect(result.stderr.length).toBeLessThanOrEqual(4096);
  }, 40_000);
  it('contains Redline, not Docker orchestration or a Docker socket', async () => {
    const { env } = await environment();
    const raw = docker(['run', '--rm', ...profile, '--network', 'none', '--entrypoint', 'node', image(), '-e',
      "const f=require('node:fs'),c=require('node:child_process');console.log(JSON.stringify({redline:f.existsSync('/opt/redline/bin/redline.mjs'),client:f.existsSync('/opt/redline/src/harness-executor/docker-client.ts'),socket:f.existsSync('/var/run/docker.sock'),docker:c.spawnSync('docker',['--version']).error?.code,node:process.version,bun:c.execFileSync('bun',['--version'],{encoding:'utf8'}).trim(),uid:process.getuid()}))"], env);
    expect(JSON.parse(raw)).toMatchObject({ redline: true, client: false, socket: false, docker: 'ENOENT', node: 'v24.21.0', bun: '1.4.4', uid: 10001 });
  }, 40_000);
});
