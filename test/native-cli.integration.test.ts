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
function warmupTarget(model: ModelBody): { head: string; sourceDirectory: string } | undefined {
  for (const message of model.messages ?? []) {
    if (message.role !== 'user') continue;
    const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.map(part => typeof part?.text === 'string' ? part.text : '').join('') : '';
    try {
      const parsed = JSON.parse(content);
      if (parsed.kind === 'REDLINE_NATIVE_WARMUP') return { head: parsed.head, sourceDirectory: parsed.sourceDirectory };
    } catch { /* Normal file payloads are length-delimited rather than plain JSON. */ }
  }
  return undefined;
}
function stream(response: ServerResponse, delta: unknown, stop: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: ' + JSON.stringify({ id: 'native-response', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  response.write('data: ' + JSON.stringify({ id: 'native-response', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: stop }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) + '\n\n');
  response.end('data: [DONE]\n\n');
}
async function fixture(graph: 'failed' | 'missing' | 'ready' | 'deferred' = 'failed') {
  const root = await mkdtemp(join(tmpdir(), 'redline-native-cli-'));
  const repo = join(root, 'repo'), home = join(root, 'home'), output = join(root, 'output');
  await Promise.all([repo, home].map(path => mkdir(path)));
  const requests: ModelBody[] = [], calls: string[] = [];
  const graphCalls: string[] = [];
  let indexedRoot: string | undefined;
  let graphSessions = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') { json(response, { error: 'method not allowed' }, 405); return; }
      const value = await body(request);
      if (request.url?.startsWith('/mcp/')) {
        const tool = request.url.slice('/mcp/'.length);
        if (!toolNames.includes(tool) && tool !== 'cgc' && tool !== 'gitnexus') { json(response, {}, 404); return; }
        const id = value['id'];
        if (value['method'] === 'initialize') {
          if (tool === 'cgc') graphSessions++;
          if (tool === 'gitnexus') await new Promise(resolve => setTimeout(resolve, 1500));
          json(response, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: tool, version: '1.0.0' } } });
        } else if (value['method'] === 'tools/list') {
          json(response, { jsonrpc: '2.0', id, result: { tools: (tool === 'cgc' ? ['cgc_index', 'cgc_query'] : tool === 'gitnexus' ? ['query'] : [tool]).map(name => ({ name, description: 'Synthetic native configuration check',
            inputSchema: tool === 'cgc' ? { type: 'object', properties: { sourceDirectory: { type: 'string' } }, required: ['sourceDirectory'], additionalProperties: false } : { type: 'object', properties: {} } })) } });
        } else if (value['method'] === 'tools/call') {
          if (tool === 'cgc') {
            const params = value['params'] as { name: string; arguments: { sourceDirectory: string } };
            const directory = params.arguments.sourceDirectory;
            const hostDirectory = directory.startsWith('/output/') ? join(output, directory.slice('/output/'.length)) : directory;
            if (!hostDirectory.startsWith(root + '/output/')) throw new Error('synthetic graph escaped captured output');
            if (params.name === 'cgc_index') {
              expect(await readFile(join(hostDirectory, 'sample.ts'), 'utf8')).toBe('export const value = 2;\n');
              indexedRoot = directory;
            } else expect(indexedRoot).toBe(directory);
            graphCalls.push(params.name);
            json(response, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'captured sample indexed; files=1; ' + params.name + '-ok' }] } });
          } else {
            calls.push(tool);
            json(response, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: tool + '-ok' }] } });
          }
        } else if (id === undefined) { response.writeHead(202); response.end(); }
        else json(response, { jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported synthetic method' } });
        return;
      }
      if (request.url !== '/v1/chat/completions') { json(response, { error: 'unknown synthetic route' }, 404); return; }
      expect(request.headers.authorization).toBe('Bearer ' + key);
      const model = value as ModelBody;
      requests.push(model);
      const target = warmupTarget(model);
      const query = model.tools?.find(tool => tool.function.name.endsWith('cgc_query'))?.function.name;
      const index = model.tools?.find(tool => tool.function.name.endsWith('cgc_index'))?.function.name;
      if (target !== undefined) {
        const resultCount = model.messages?.filter(message => message.role === 'tool').length ?? 0;
        if (graph === 'deferred' && resultCount === 0) {
          expect(JSON.stringify(model.messages)).toContain('First perform native tool discovery');
          const tool = model.tools?.find(tool => tool.function.name === 'codemode');
          if (tool === undefined) throw new Error('native codemode missing');
          const script = 'text(ALL_TOOLS.filter(tool => tool.name.includes("gitnexus")).map(tool => tool.name));';
          const schema = (tool.function as { parameters?: { properties?: Record<string, unknown> } }).parameters;
          const key = Object.keys(schema?.properties ?? {})[0] ?? 'code';
          stream(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'warmup-discovery', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ [key]: script }) } }] }, 'tool_calls');
          return;
        }
        if (graph === 'ready' && resultCount < 2) {
          const name = resultCount === 0 ? index : query;
          if (name === undefined) throw new Error('native graph tool missing');
          stream(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'warmup-' + resultCount, type: 'function', function: { name, arguments: JSON.stringify({ sourceDirectory: target.sourceDirectory }) } }] }, 'tool_calls');
          return;
        }
        const report = { kind: 'REDLINE_NATIVE_WARMUP', ...target, integrations: ['cgc', 'gitnexus', 'context-mode', 'sequential-thinking'].map(component => ({
          component, availability: component === 'cgc' && graph === 'ready' || component === 'gitnexus' && graph === 'deferred' ? 'available' : 'unavailable',
          tools: component === 'cgc' && graph === 'ready' ? [index, query] : component === 'gitnexus' && graph === 'deferred' ? ['mcp__codeindex_gitnexus__query'] : [],
          indexStatus: component === 'cgc' && graph === 'ready' ? 'ready' : 'unavailable',
          indexedFiles: component === 'cgc' && graph === 'ready' ? 1 : null,
          persistence: component === 'cgc' && graph === 'ready' ? 'shared' : 'unknown',
          queryTool: component === 'cgc' && graph === 'ready' ? query : null, reason: component === 'cgc' && graph === 'ready' ? 'Captured source indexed and queried.' : 'Not available in this synthetic native configuration.',
        })) };
        stream(response, { role: 'assistant', content: JSON.stringify(report) }, 'stop'); return;
      }
      const hasResults = model.messages?.some(message => message.role === 'tool');
      const selected = toolNames.map(suffix => model.tools?.find(tool => tool.function.name.endsWith(suffix))?.function.name);
      if (!hasResults && selected.some(name => name === undefined)) { json(response, { error: { message: 'native global/local/extra MCP declarations missing; observed: ' + JSON.stringify(model.tools?.map(tool => tool.function.name) ?? []) } }, 400); return; }
      const document = JSON.stringify({ version: 4, fileId: '000001', outcome: 'findings', contextRequests: [], findings: [reviewFinding({ evidence: 'export const value = 2;' })] });
      if (graph === 'ready') expect(JSON.stringify(model.messages)).toContain('reported-ready');
      const selectedCalls = selected.map((name, index) => ({ index, id: 'native-' + index, type: 'function', function: { name, arguments: '{}' } }));
      if (graph === 'ready') selectedCalls.push({ index: 3, id: 'native-query', type: 'function', function: { name: query, arguments: JSON.stringify({ sourceDirectory: indexedRoot }) } });
      const delta = hasResults ? { role: 'assistant', content: document } : { role: 'assistant', tool_calls: selectedCalls };
      stream(response, delta, hasResults ? 'stop' : 'tool_calls');
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
  await writeFile(join(home, '.pi/agent/settings.json'), JSON.stringify({ defaultTools: graph === 'deferred' ? ['read', 'codemode'] : ['read'], quietStartup: true, retry: { enabled: false } }));
  await writeFile(join(home, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { global_fixture: piServer('global_ping'), ...(graph === 'deferred' ? { codeindex_gitnexus: { url: endpoint + '/mcp/gitnexus', exposure: 'codemode' } } : {}), ...(graph === 'ready' ? { cgc: piServer('cgc') } : graph === 'failed' ? { cgc: { command: '/redline-synthetic-missing-mcp', args: [] } } : {}) } }));
  await writeFile(join(repo, '.pi/mcp.json'), JSON.stringify({ mcpServers: { local_fixture: piServer('local_ping'), extra_fixture: piServer('extra_ping') } }));
  await writeFile(join(home, '.pi/agent/models.json'), JSON.stringify({ providers: { openrouter: { baseUrl: endpoint + '/v1', api: 'openai-completions', apiKey: '$REDLINE_MODEL_API_KEY', models: [{ id: 'test-model', name: 'Native test', reasoning: true, contextWindow: 128000, maxTokens: 4096 }] } } }));
  await mkdir(join(home, '.config/opencode'), { recursive: true });
  const ocServer = (tool: string) => ({ type: 'remote', url: endpoint + '/mcp/' + tool });
  await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { global_fixture: ocServer('global_ping'), ...(graph === 'ready' ? { cgc: ocServer('cgc') } : graph === 'failed' ? { cgc: { type: 'local', command: ['/redline-synthetic-missing-mcp'], enabled: true } } : {}) } }));
  await writeFile(join(repo, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { local_fixture: ocServer('local_ping'), extra_fixture: ocServer('extra_ping') } }));
  return { root, repo, home, output, env, endpoint, base, requests, calls, graphCalls, get graphSessions() { return graphSessions; },
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

for (const runtime of ['cli', 'docker'] as const) {
describe.runIf(runtime === 'cli' ? enabled : containerEnabled)('full native ' + runtime + ' integration', () => {
  for (const harness of ['pi', 'opencode'] as const) {
    for (const { graph, tty } of [{ graph: 'missing', tty: false }, { graph: 'ready', tty: false }, { graph: 'missing', tty: true }, ...(harness === 'pi' ? [{ graph: 'deferred', tty: false }] as const : [])] as const) it(harness + ' warms up ' + (graph === 'deferred' ? 'deferred GitNexus discovery' : graph + ' CGC') + ' before reviewing' + (tty ? ' with live PTY progress through tee' : ' with global/local/extra MCPs'), async () => {
      const f = await fixture(graph);
      try {
        const configuredFiles = [
          ...['.pi/agent/settings.json', '.pi/agent/models.json', '.pi/agent/mcp.json', '.config/opencode/opencode.json'].map(path => join(f.home, path)),
          join(f.repo, '.pi/mcp.json'), join(f.repo, 'opencode.json'),
        ];
        const before = await Promise.all(configuredFiles.map(path => readFile(path, 'utf8')));
        const command = ['bash', join(packageRoot, 'test-cli.sh'), ...(runtime === 'docker' ? ['--docker'] : []), harness];
        const child = spawn(tty ? 'python3' : command[0]!, tty ? [join(packageRoot, 'test/fixtures/pty-run.py'), ...command] : command.slice(1),
        { cwd: f.repo, env: { ...f.env, TERM: 'xterm-256color', TEST_NODE: process.execPath,
          TEST_LOG_DIR: join(f.root, 'logs'), TEST_OUTPUT_DIR: f.output,
          TEST_DOCKER_IMAGE: process.env.REDLINE_NATIVE_IMAGE ?? 'redline-native209:dev',
          TEST_SKIP_BUILD: '1', TEST_DOCKER_HOME: f.home, TEST_DOCKER_NETWORK: 'host',
          REDLINE_PROVIDER: 'openrouter', REDLINE_ENDPOINT: f.endpoint + '/v1', REDLINE_MODEL: 'test-model',
          REDLINE_BASE: f.base, REDLINE_INDEXING: 'disabled', REDLINE_RETRIES: '0',
          REDLINE_REVIEW_CONCURRENCY: '1', REDLINE_TIMEOUT: '1m', REDLINE_RUN_TIMEOUT: '2m',
          REDLINE_MAX_OUTPUT_TOKENS: '8192', REDLINE_MODEL_PROTOCOL: harness === 'pi' ? 'openrouter-json' : 'compatible',
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
        expect(stdout.includes('\u001b[2K')).toBe(tty);
        expect(stdout).toContain(runtime === 'cli' ? 'UNSANDBOXED NATIVE CLI' : 'Docker is the execution isolation boundary');
        const logFiles = await readdir(join(f.root, 'logs'));
        expect(logFiles).toHaveLength(1);
        expect(await readFile(join(f.root, 'logs', logFiles[0]!), 'utf8')).toBe(stdout);
        const outputDirs = await readdir(f.output);
        expect(outputDirs).toHaveLength(1);
        const output = join(f.output, outputDirs[0]!);
        expect(f.calls.sort()).toEqual(toolNames.slice().sort());
        expect(f.requests.length).toBeGreaterThanOrEqual(3);
        expect(warmupTarget(f.requests[0]!)).toBeDefined();
        expect(stdout.indexOf('Native warmup: completed')).toBeLessThan(stdout.indexOf('Workload:'));
        const warmup = JSON.parse(await readFile(join(output, 'reviews/warmup.json'), 'utf8'));
        expect(warmup.status).toBe('completed');
        if (graph === 'deferred') {
          expect(warmup.integrations.find((row: { component: string }) => row.component === 'gitnexus').availability).toBe('observed');
          expect(warmup.tools.catalogue).toContain('mcp__codeindex_gitnexus__query');
          const discovery = JSON.stringify(f.requests.filter(request => warmupTarget(request) !== undefined).flatMap(request => request.messages?.filter(message => message.role === 'tool') ?? []));
          expect(discovery).toContain('mcp__codeindex_gitnexus__query');
          expect(warmup.tools.calls.find((call: { name: string }) => call.name === 'codemode')?.succeeded).toBe(1);
        }
        if (graph === 'ready') {
          expect(warmup.integrations[0]).toMatchObject({ indexStatus: 'reported-ready', queryObserved: true, indexedFiles: 1 });
          expect(f.graphCalls).toEqual(['cgc_index', 'cgc_query', 'cgc_query']);
          expect(f.graphSessions).toBeGreaterThanOrEqual(2);
        } else {
          expect(warmup.integrations[0].availability).toBe('not-observed');
          expect(stdout.indexOf('Warning: cgc warmup')).toBeLessThan(stdout.indexOf('Workload:'));
        }
        for (const request of f.requests) {
          expect(request.max_tokens ?? request.max_completion_tokens).toBe(warmupTarget(request) === undefined ? 8192 : 4096);
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
        expect(result.tools.calls.reduce((n: number, call: { succeeded: number }) => n + call.succeeded, 0)).toBe(graph === 'ready' ? 4 : 3);
        const report = await readFile(join(output, 'reviews/native-tools.json'), 'utf8');
        expect(report).toContain('extra_ping');
        expect(JSON.parse(report).requestedMcp.find((row: { component: string }) => row.component === 'cgc').observation).toBe(graph === 'ready' ? 'observed' : 'not-observed');
        expect(JSON.parse(report).warmupReport).toBe('warmup.json');
        expect(report + stdout + stderr + JSON.stringify(result)).not.toContain(key);
      } finally { await f.close(); }
    }, 80000);
  }
});
}
