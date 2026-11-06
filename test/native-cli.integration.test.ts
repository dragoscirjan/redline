import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reviewFinding } from './helpers/finding.ts';

const exec = promisify(execFile);
const enabled = process.env.REDLINE_NATIVE_CLI_TESTS === '1';
const containerEnabled = process.env.REDLINE_NATIVE_CONTAINER_TESTS === '1';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const key = 'synthetic-native-cli-key-do-not-persist';
const toolNames = ['global_ping', 'local_ping', 'extra_ping'];
interface ModelBody {
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly response_format?: { readonly type?: string };
  readonly provider?: { readonly require_parameters?: boolean };
  readonly reasoning?: { readonly enabled?: boolean; readonly effort?: string };
  readonly tools?: readonly { function: { name: string } }[];
  readonly messages?: readonly { role: string; content: unknown }[];
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) { text += String(chunk); if (text.length > 2_000_000) throw new Error('oversized synthetic request'); }
  return text === '' ? {} : JSON.parse(text) as Record<string, unknown>;
}
function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data));
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'redline-native-cli-'));
  const repo = join(root, 'repo'), home = join(root, 'home'), output = join(root, 'output');
  await Promise.all([repo, home].map(path => mkdir(path)));
  const requests: ModelBody[] = [], calls: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') { json(response, { error: 'method not allowed' }, 405); return; }
      const value = await body(request);
      if (request.url?.startsWith('/mcp/')) {
        const tool = request.url.slice('/mcp/'.length);
        if (!toolNames.includes(tool)) { json(response, {}, 404); return; }
        const id = value['id'];
        if (value['method'] === 'initialize') {
          json(response, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: tool, version: '1.0.0' } } });
        } else if (value['method'] === 'tools/list') {
          json(response, { jsonrpc: '2.0', id, result: { tools: [{ name: tool, description: 'Synthetic native configuration check', inputSchema: { type: 'object', properties: {} } }] } });
        } else if (value['method'] === 'tools/call') {
          calls.push(tool);
          json(response, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: tool + '-ok' }] } });
        } else if (id === undefined) { response.writeHead(202); response.end(); }
        else json(response, { jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported synthetic method' } });
        return;
      }
      if (request.url !== '/v1/chat/completions') { json(response, { error: 'unknown synthetic route' }, 404); return; }
      expect(request.headers.authorization).toBe('Bearer ' + key);
      const model = value as ModelBody;
      requests.push(model);
      const hasResults = model.messages?.some(message => message.role === 'tool');
      const selected = toolNames.map(suffix => model.tools?.find(tool => tool.function.name.endsWith(suffix))?.function.name);
      if (!hasResults && selected.some(name => name === undefined)) { json(response, { error: { message: 'native global/local/extra MCP declarations missing; observed: ' + JSON.stringify(model.tools?.map(tool => tool.function.name) ?? []) } }, 400); return; }
      const document = JSON.stringify({ version: 4, fileId: '000001', outcome: 'findings', contextRequests: [], findings: [reviewFinding({ evidence: 'export const value = 2;' })] });
      const delta = hasResults ? { role: 'assistant', content: document }
        : { role: 'assistant', tool_calls: selected.map((name, index) => ({ index, id: 'native-' + index, type: 'function', function: { name, arguments: '{}' } })) };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'native-response', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ id: 'native-response', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: hasResults ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch { json(response, { error: { message: 'synthetic fixture failed' } }, 500); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('synthetic endpoint unavailable');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'sample.ts'), 'export const value = 1;\n'); await git('add', '.'); await git('commit', '-m', 'base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('checkout', '-b', 'feature'); await writeFile(join(repo, 'sample.ts'), 'export const value = 2;\n'); await git('add', '.'); await git('commit', '-m', 'change');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    ...(process.env.DOCKER_HOST === undefined ? {} : { DOCKER_HOST: process.env.DOCKER_HOST }),
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_TELEMETRY: '1',
    REDLINE_MODEL_AUTH: JSON.stringify({ openrouter: key }),
  };
  await mkdir(join(home, '.pi/agent'), { recursive: true }); await mkdir(join(repo, '.pi'), { recursive: true });
  const piServer = (tool: string) => ({ url: endpoint + '/mcp/' + tool, exposure: 'direct' });
  await writeFile(join(home, '.pi/agent/settings.json'), JSON.stringify({ defaultTools: ['read'], quietStartup: true, retry: { enabled: false } }));
  await writeFile(join(home, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { global_fixture: piServer('global_ping'), cgc: { command: '/redline-synthetic-missing-mcp', args: [] } } }));
  await writeFile(join(repo, '.pi/mcp.json'), JSON.stringify({ mcpServers: { local_fixture: piServer('local_ping'), extra_fixture: piServer('extra_ping') } }));
  await writeFile(join(home, '.pi/agent/models.json'), JSON.stringify({ providers: { openrouter: { baseUrl: endpoint + '/v1', api: 'openai-completions', apiKey: '$REDLINE_MODEL_API_KEY', models: [{ id: 'test-model', name: 'Native test', reasoning: true, contextWindow: 128000, maxTokens: 4096 }] } } }));
  await mkdir(join(home, '.config/opencode'), { recursive: true });
  const ocServer = (tool: string) => ({ type: 'remote', url: endpoint + '/mcp/' + tool });
  await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { global_fixture: ocServer('global_ping'), cgc: { type: 'local', command: ['/redline-synthetic-missing-mcp'], enabled: true } } }));
  await writeFile(join(repo, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { local_fixture: ocServer('local_ping'), extra_fixture: ocServer('extra_ping') } }));
  return { root, repo, home, output, env, endpoint, base, requests, calls,
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

for (const runtime of ['cli', 'docker'] as const) {
describe.runIf(runtime === 'cli' ? enabled : containerEnabled)('full native ' + runtime + ' integration', () => {
  for (const harness of ['pi', 'opencode'] as const) {
    it(harness + ' loads global/local MCPs, exposes extras, calls them and returns a validated finding', async () => {
      const f = await fixture();
      try {
        const configuredFiles = [
          ...['.pi/agent/settings.json', '.pi/agent/models.json', '.pi/agent/mcp.json', '.config/opencode/opencode.json'].map(path => join(f.home, path)),
          join(f.repo, '.pi/mcp.json'), join(f.repo, 'opencode.json'),
        ];
        const before = await Promise.all(configuredFiles.map(path => readFile(path, 'utf8')));
        const child = spawn('bash', [join(packageRoot, 'test-cli.sh'), ...(runtime === 'docker' ? ['--docker'] : []), harness],
        { cwd: f.repo, env: { ...f.env, TEST_NODE: process.execPath,
          TEST_LOG_DIR: join(f.root, 'logs'), TEST_OUTPUT_DIR: f.output,
          TEST_DOCKER_IMAGE: process.env.REDLINE_NATIVE_IMAGE ?? 'redline-native209:dev',
          TEST_SKIP_BUILD: '1', TEST_DOCKER_HOME: f.home, TEST_DOCKER_NETWORK: 'host',
          REDLINE_PROVIDER: 'openrouter', REDLINE_ENDPOINT: f.endpoint + '/v1', REDLINE_MODEL: 'test-model',
          REDLINE_BASE: f.base, REDLINE_INDEXING: 'disabled', REDLINE_RETRIES: '0',
          REDLINE_REVIEW_CONCURRENCY: '1', REDLINE_TIMEOUT: '1m', REDLINE_RUN_TIMEOUT: '2m',
          REDLINE_MAX_OUTPUT_TOKENS: '4096', REDLINE_MODEL_PROTOCOL: harness === 'pi' ? 'openrouter-json' : 'compatible',
        }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-20000); });
        child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-20000); });
        const code = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native CLI fixture timed out')); }, 70000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
        expect(code, stdout + '\n' + stderr).toBe(0);
        expect(stdout).toContain(runtime === 'cli' ? 'UNSANDBOXED NATIVE CLI' : 'Docker is the execution isolation boundary');
        const logFiles = await readdir(join(f.root, 'logs'));
        expect(logFiles).toHaveLength(1);
        expect(await readFile(join(f.root, 'logs', logFiles[0]!), 'utf8')).toBe(stdout);
        const outputDirs = await readdir(f.output);
        expect(outputDirs).toHaveLength(1);
        const output = join(f.output, outputDirs[0]!);
        expect(f.calls.sort()).toEqual(toolNames.slice().sort());
        expect(f.requests.length).toBeGreaterThanOrEqual(2);
        for (const request of f.requests) {
          expect(request.max_tokens ?? request.max_completion_tokens).toBe(4096);
          expect(request.reasoning?.enabled).not.toBe(false);
          expect(request.reasoning?.effort).not.toBe('none');
          if (harness === 'pi') {
            expect(request.provider?.require_parameters).toBe(true);
            expect(request.response_format?.type).toBe('json_schema');
          }
        }
        const returnedTools = JSON.stringify(f.requests.flatMap(request => request.messages?.filter(message => message.role === 'tool') ?? []));
        for (const name of toolNames) expect(returnedTools).toContain(name + '-ok');
        if (harness === 'pi') {
          const names = f.requests[0]?.tools?.map(tool => tool.function.name) ?? [];
          expect(names).toContain('read');
          expect(names).not.toContain('write');
        }
        const after = await Promise.all(configuredFiles.map(path => readFile(path, 'utf8')));
        for (const [index, content] of after.entries()) expect(content, configuredFiles[index]).toBe(before[index]);
        const result = JSON.parse(await readFile(join(output, 'reviews/000001.json'), 'utf8'));
        expect(result.outcome, result.reason).toBe('findings');
        expect(result.findings[0].evidence).toBe('export const value = 2;');
        if (harness === 'pi') {
          expect(result.tools.catalogueSource).toBe('harness-catalogue');
          expect(result.tools.catalogue).toContain('read');
          expect(result.tools.catalogue).not.toContain('write');
        }
        expect(result.tools.calls.reduce((n: number, call: { succeeded: number }) => n + call.succeeded, 0)).toBe(3);
        if (harness === 'opencode') expect(result.tools.servers.find((server: { name: string }) => server.name === 'cgc')?.status).toBe('failed');
        const report = await readFile(join(output, 'reviews/native-tools.json'), 'utf8');
        expect(report).toContain('extra_ping');
        expect(report + stdout + stderr + JSON.stringify(result)).not.toContain(key);
      } finally { await f.close(); }
    }, 80000);
  }
});
}
