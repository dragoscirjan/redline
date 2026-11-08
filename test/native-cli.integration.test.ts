import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewFinding } from './helpers/finding.ts';
import { prepareCompiledTool } from './helpers/compiled-tool.ts';

const exec = promisify(execFile);
const enabled = process.env.REDLINE_NATIVE_CLI_TESTS === '1';
const containerEnabled = process.env.REDLINE_NATIVE_CONTAINER_TESTS === '1';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
let tool: Awaited<ReturnType<typeof prepareCompiledTool>> | undefined;
beforeAll(async () => {
  if (enabled || containerEnabled) tool = await prepareCompiledTool();
}, 60_000);
afterAll(async () => { await tool?.close(); }, 60_000);
const key = 'synthetic-native-cli-key-do-not-persist';
const toolNames = ['global_ping', 'local_ping', 'extra_ping'];
interface ModelBody {
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly response_format?: { readonly type?: string };
  readonly tool_choice?: unknown;
  readonly provider?: { readonly require_parameters?: boolean };
  readonly reasoning?: { readonly enabled?: boolean; readonly effort?: string };
  readonly tools?: readonly { function: { name: string } }[];
  readonly messages?: readonly { role: string; content: unknown }[];
}
/** Bound synthetic HTTP request bodies before parsing fixture JSON. */
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) { text += String(chunk); if (text.length > 2_000_000) throw new Error('oversized synthetic request'); }
  return text === '' ? {} : JSON.parse(text) as Record<string, unknown>;
}
function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data));
}
/** Recognize the explicit warmup user payload without confusing length-delimited file-review data with setup instructions. */
function warmupTarget(model: ModelBody): { head: string; sourceDirectory: string; indexingProvider: 'cgc' | 'gitnexus' | null } | undefined {
  for (const message of model.messages ?? []) {
    if (message.role !== 'user') continue;
    const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.map(part => typeof part?.text === 'string' ? part.text : '').join('') : '';
    try {
      const parsed = JSON.parse(content);
      if (parsed.kind === 'REDLINE_NATIVE_WARMUP') return { head: parsed.head, sourceDirectory: parsed.sourceDirectory, indexingProvider: parsed.indexingProvider };
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
/** Isolate synthetic Git history, native configuration, credentials, and loopback MCP/model endpoints; the caller owns teardown. */
async function fixture(graph: 'failed' | 'missing' | 'ready' | 'deferred' | 'needs-choice' | 'lying' | 'codemode-ready' | 'unprobed-missing' = 'failed') {
  if (tool === undefined) throw new Error('Compiled native CLI fixture is unavailable');
  const driver = tool.driver;
  const graphConfigured = ['ready', 'needs-choice', 'lying', 'codemode-ready'].includes(graph);
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
          json(response, { jsonrpc: '2.0', id, result: { tools: (tool === 'cgc' ? ['cgc_index', 'cgc_query'] : tool === 'gitnexus' ? ['query'] : tool === 'global_ping' ? [tool, 'probe_indexer'] : [tool]).map(name => ({ name, description: 'Synthetic native configuration check',
            inputSchema: tool === 'cgc' ? { type: 'object', properties: { sourceDirectory: { type: 'string' } }, required: ['sourceDirectory'], additionalProperties: false } : { type: 'object', properties: {} } })) } });
        } else if (value['method'] === 'tools/call') {
          if ((value['params'] as { name?: string })?.name === 'probe_indexer') {
            json(response, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Synthetic provider installation probe: no usable indexing CLI or indexing operation is installed.' }] } });
          } else if (tool === 'cgc') {
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
      const query = graph === 'codemode-ready' ? 'mcp__cgc__cgc_query' : model.tools?.find(tool => tool.function.name.endsWith('cgc_query'))?.function.name;
      const index = graph === 'codemode-ready' ? 'mcp__cgc__cgc_index' : model.tools?.find(tool => tool.function.name.endsWith('cgc_index'))?.function.name;
      if (target !== undefined) {
        const resultCount = model.messages?.filter(message => message.role === 'tool').length ?? 0;
        if (graph === 'codemode-ready' && resultCount < 3) {
          const tool = model.tools?.find(tool => tool.function.name === 'codemode');
          if (tool === undefined) throw new Error('native codemode missing');
          const script = resultCount === 0 ? 'text(ALL_TOOLS.filter(tool => tool.name.includes("cgc")).map(tool => tool.name));'
            : 'text(await tools.' + (resultCount === 1 ? index : query) + '(' + JSON.stringify({ sourceDirectory: target.sourceDirectory }) + '));';
          const schema = (tool.function as { parameters?: { properties?: Record<string, unknown> } }).parameters;
          const key = Object.keys(schema?.properties ?? {})[0] ?? 'code';
          stream(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'warmup-codemode-' + resultCount, type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ [key]: script }) } }] }, 'tool_calls');
          return;
        }
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
        if ((graph === 'ready' || graph === 'needs-choice' && (resultCount > 0 || model.tool_choice !== undefined)) && resultCount < 2) {
          const name = resultCount === 0 ? index : query;
          if (name === undefined) throw new Error('native graph tool missing');
          stream(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'warmup-' + resultCount, type: 'function', function: { name, arguments: JSON.stringify({ sourceDirectory: target.sourceDirectory }) } }] }, 'tool_calls');
          return;
        }
        const ready = graphConfigured;
        const probe = model.tools?.find(tool => tool.function.name.endsWith('probe_indexer'))?.function.name;
        if (!ready && graph !== 'unprobed-missing' && resultCount < (graph === 'deferred' ? 2 : 1)) {
          if (probe === undefined) throw new Error('synthetic installation probe missing');
          stream(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'warmup-probe', type: 'function', function: { name: probe, arguments: '{}' } }] }, 'tool_calls');
          return;
        }
        const { indexingProvider, ...identity } = target;
        const report = { kind: 'REDLINE_NATIVE_WARMUP', ...identity, integrations: [
          ...['context-mode', 'sequential-thinking'].map(component => ({ component, availability: 'unavailable', tools: [], reason: 'Missing optional tool in this synthetic configuration.' })),
          ...(indexingProvider === null ? [] : [{ component: indexingProvider, availability: ready ? 'available' : 'unavailable',
            tools: ready ? [index, query] : graph === 'deferred' ? ['mcp__codeindex_gitnexus__query'] : [],
            indexStatus: ready ? 'ready' : 'unavailable', indexedFiles: ready ? graph === 'lying' ? 120 : 1 : null,
            persistence: ready ? 'shared' : 'unknown', probeTool: graph === 'unprobed-missing' ? null : ready ? index : probe, indexTool: ready ? index : null,
            queryTool: ready ? query : null, reason: ready ? 'Captured source indexed and queried.' : 'No usable indexer installed in this synthetic configuration.' }]),
        ] };
        stream(response, { role: 'assistant', content: JSON.stringify(report) }, 'stop'); return;
      }
      const hasResults = model.messages?.some(message => message.role === 'tool');
      const selected = toolNames.map(suffix => model.tools?.find(tool => tool.function.name.endsWith(suffix))?.function.name);
      if (!hasResults && selected.some(name => name === undefined)) { json(response, { error: { message: 'native global/local/extra MCP declarations missing; observed: ' + JSON.stringify(model.tools?.map(tool => tool.function.name) ?? []) } }, 400); return; }
      const document = JSON.stringify({ version: 4, fileId: '000001', outcome: 'findings', contextRequests: [], findings: [reviewFinding({ evidence: 'export const value = 2;' })],
        impactAnalysis: { status: graphConfigured ? 'checked' : 'partial', changedSymbols: ['value'], callers: [],
          summary: 'Changed the exported value; checked captured-source impact.', limitation: graphConfigured ? '' : 'Selected indexer unavailable; bounded source-only impact inspection.' } });
      if (graphConfigured) expect(JSON.stringify(model.messages)).toContain('reported-ready');
      const selectedCalls = selected.map((name, index) => ({ index, id: 'native-' + index, type: 'function', function: { name, arguments: '{}' } }));
      if (graph === 'codemode-ready') {
        const tool = model.tools?.find(tool => tool.function.name === 'codemode');
        const schema = (tool?.function as { parameters?: { properties?: Record<string, unknown> } } | undefined)?.parameters;
        const key = Object.keys(schema?.properties ?? {})[0] ?? 'code';
        selectedCalls.push({ index: 3, id: 'native-query', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ [key]: 'text(await tools.' + query + '(' + JSON.stringify({ sourceDirectory: indexedRoot }) + '));' }) } });
      } else if (graphConfigured) selectedCalls.push({ index: 3, id: 'native-query', type: 'function', function: { name: query, arguments: JSON.stringify({ sourceDirectory: indexedRoot }) } });
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
  await writeFile(join(home, '.pi/agent/settings.json'), JSON.stringify({ defaultTools: graph === 'deferred' || graph === 'codemode-ready' ? ['read', 'codemode'] : ['read'], quietStartup: true, retry: { enabled: false } }));
  await writeFile(join(home, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { global_fixture: piServer('global_ping'), ...(graph === 'deferred' ? { codeindex_gitnexus: { url: endpoint + '/mcp/gitnexus', exposure: 'codemode' } } : {}), ...(graphConfigured ? { cgc: { ...piServer('cgc'), ...(graph === 'codemode-ready' ? { exposure: 'codemode' } : {}) } } : graph === 'failed' ? { cgc: { command: '/redline-synthetic-missing-mcp', args: [] } } : {}) } }));
  await writeFile(join(repo, '.pi/mcp.json'), JSON.stringify({ mcpServers: { local_fixture: piServer('local_ping'), extra_fixture: piServer('extra_ping') } }));
  await writeFile(join(home, '.pi/agent/models.json'), JSON.stringify({ providers: { openrouter: { baseUrl: endpoint + '/v1', api: 'openai-completions', apiKey: '$REDLINE_MODEL_API_KEY', models: [{ id: 'test-model', name: 'Native test', reasoning: true, contextWindow: 128000, maxTokens: 4096 }] } } }));
  await mkdir(join(home, '.config/opencode'), { recursive: true });
  const ocServer = (tool: string) => ({ type: 'remote', url: endpoint + '/mcp/' + tool });
  await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { global_fixture: ocServer('global_ping'), ...(graphConfigured ? { cgc: ocServer('cgc') } : graph === 'failed' ? { cgc: { type: 'local', command: ['/redline-synthetic-missing-mcp'], enabled: true } } : {}) } }));
  await writeFile(join(repo, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { local_fixture: ocServer('local_ping'), extra_fixture: ocServer('extra_ping') } }));
  return { root, repo, home, output, driver, env, endpoint, base, requests, calls, graphCalls, get graphSessions() { return graphSessions; },
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

describe.runIf(enabled)('native warmup with a non-cooperative model', () => {
  it('opencode configuration parse failures never expose unselected inline credentials in Redline logs or artifacts', async () => {
    const f = await fixture();
    try {
      const selected = 'native"selected-key';
      const unselected = 'private-unselected-inline-key';
      const child = spawn('bash', [f.driver, 'opencode'], { cwd: f.repo, env: { ...f.env,
        TEST_NODE: process.execPath, TEST_LOG_DIR: join(f.root, 'logs'), TEST_OUTPUT_DIR: f.output,
        REDLINE_PROVIDER: 'openrouter', REDLINE_ENDPOINT: f.endpoint + '/v1', REDLINE_MODEL: 'test-model', REDLINE_BASE: f.base,
        REDLINE_MODEL_AUTH: JSON.stringify({ openrouter: selected }), REDLINE_RETRIES: '0', REDLINE_INDEXING: 'disabled',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { other: { options: { apiKey: unselected } } } }),
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { output += String(b); });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native configuration diagnostic timeout')); }, 70_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      expect(code).not.toBe(0); expect(f.requests).toEqual([]);
      for (const directory of [f.output, join(f.root, 'logs')]) {
        const files = await readdir(directory, { recursive: true, withFileTypes: true });
        output += (await Promise.all(files.filter(file => file.isFile()).map(file => readFile(join(file.parentPath, file.name), 'utf8')))).join('\n');
      }
      expect(output).toContain('diagnostic suppressed');
      expect(output).not.toContain(selected); expect(output).not.toContain(unselected);
    } finally { await f.close(); }
  }, 80_000);

  for (const { harness, graph } of [{ harness: 'pi', graph: 'needs-choice' }, { harness: 'pi', graph: 'lying' }, { harness: 'opencode', graph: 'lying' },
    { harness: 'pi', graph: 'unprobed-missing' }, { harness: 'opencode', graph: 'unprobed-missing' }] as const) {
    it(harness + ' ' + graph + ' cannot claim completed indexing without execution', async () => {
      const f = await fixture(graph);
      try {
        const child = spawn('bash', [f.driver, harness], { cwd: f.repo, env: { ...f.env,
          TEST_NODE: process.execPath, TEST_LOG_DIR: join(f.root, 'logs'), TEST_OUTPUT_DIR: f.output,
          REDLINE_PROVIDER: 'openrouter', REDLINE_ENDPOINT: f.endpoint + '/v1', REDLINE_MODEL: 'test-model', REDLINE_BASE: f.base,
          REDLINE_INDEXING: 'enabled', REDLINE_INDEXING_PROVIDER: 'cgc', REDLINE_RETRIES: '0', REDLINE_REVIEW_CONCURRENCY: '1',
          REDLINE_TIMEOUT: '1m', REDLINE_RUN_TIMEOUT: '2m', REDLINE_MAX_OUTPUT_TOKENS: '8192',
          REDLINE_MODEL_PROTOCOL: harness === 'pi' ? 'openrouter-json' : 'compatible',
        }, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = ''; child.stdout.on('data', b => { text = (text + String(b)).slice(-20000); }); child.stderr.on('data', b => { text = (text + String(b)).slice(-20000); });
        const code = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('warmup contract timeout')); }, 70000);
          child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
        const outputDirectories = await readdir(f.output);
        expect(outputDirectories, text).toHaveLength(1);
        const output = join(f.output, outputDirectories[0]!);
        const warmup = JSON.parse(await readFile(join(output, 'reviews/warmup.json'), 'utf8'));
        const indexer = warmup.integrations.find((row: { category: string }) => row.category === 'indexer');
        expect(text).not.toContain('Preparing cgc context');
        if (graph === 'lying') {
          expect(code, text).toBe(1); expect(warmup.status).toBe('incomplete'); expect(warmup.fatal).toBe(true);
          expect(indexer.indexedFiles).toBeNull(); expect(warmup.tools.calls).toEqual([]); expect(f.graphCalls).toEqual([]);
          expect(f.requests.filter(request => warmupTarget(request) === undefined)).toHaveLength(0);
        } else if (graph === 'unprobed-missing') {
          expect(code, text).toBe(0); expect(warmup.status).toBe('incomplete'); expect(warmup.fatal).toBe(false);
          expect(indexer.indexStatus).toBe('unverified'); expect(indexer.indexedFiles).toBeNull();
          expect(indexer.probeObserved).toBe(false); expect(indexer.indexAttempted).toBe(false);
          expect(warmup.tools.calls).toEqual([]); expect(f.graphCalls).toEqual([]);
          expect(f.requests.filter(request => warmupTarget(request) === undefined).length).toBeGreaterThan(0);
          expect(text).toContain('file-only guidance');
        } else {
          expect(code, text).toBe(0); expect(indexer.indexStatus).toBe('reported-ready');
          expect(f.graphCalls).toEqual(['cgc_index', 'cgc_query', 'cgc_query']);
          expect(f.requests[0]?.tool_choice).toBe('required'); expect(f.requests[0]?.response_format).toBeUndefined();
        }
      } finally { await f.close(); }
    }, 80000);
  }
});

for (const runtime of ['cli', 'docker'] as const) {
describe.runIf(runtime === 'cli' ? enabled : containerEnabled)('full native ' + runtime + ' integration', () => {
  for (const harness of ['pi', 'opencode'] as const) {
    for (const { graph, tty } of [{ graph: 'missing', tty: false }, { graph: 'ready', tty: false }, { graph: 'missing', tty: true }, ...(harness === 'pi' ? [{ graph: 'deferred', tty: false }, { graph: 'codemode-ready', tty: false }] as const : [])] as const) it(harness + ' warms up ' + (graph === 'deferred' ? 'deferred GitNexus discovery' : graph + ' CGC') + ' before reviewing' + (tty ? ' with live PTY progress through tee' : ' with global/local/extra MCPs'), async () => {
      const f = await fixture(graph);
      try {
        const configuredFiles = [
          ...['.pi/agent/settings.json', '.pi/agent/models.json', '.pi/agent/mcp.json', '.config/opencode/opencode.json'].map(path => join(f.home, path)),
          join(f.repo, '.pi/mcp.json'), join(f.repo, 'opencode.json'),
        ];
        const before = await Promise.all(configuredFiles.map(path => readFile(path, 'utf8')));
        const command = ['bash', f.driver, ...(runtime === 'docker' ? ['--docker'] : []), harness];
        const child = spawn(tty ? 'python3' : command[0]!, tty ? [join(packageRoot, 'test/fixtures/pty-run.py'), ...command] : command.slice(1),
        { cwd: f.repo, env: { ...f.env, TERM: 'xterm-256color', TEST_NODE: process.execPath,
          TEST_LOG_DIR: join(f.root, 'logs'), TEST_OUTPUT_DIR: f.output,
          TEST_DOCKER_IMAGE: process.env.REDLINE_NATIVE_IMAGE ?? 'redline-native209:dev',
          TEST_SKIP_BUILD: '1', TEST_DOCKER_HOME: f.home, TEST_DOCKER_NETWORK: 'host',
          REDLINE_PROVIDER: 'openrouter', REDLINE_ENDPOINT: f.endpoint + '/v1', REDLINE_MODEL: 'test-model',
          REDLINE_BASE: f.base, REDLINE_INDEXING: 'enabled', REDLINE_INDEXING_PROVIDER: graph === 'deferred' ? 'gitnexus' : 'cgc', REDLINE_RETRIES: '0',
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
        expect(stdout).toContain('UNSANDBOXED NATIVE CLI');
        expect(stdout).not.toContain('Docker is the execution isolation boundary');
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
        if (graph === 'ready' || graph === 'codemode-ready') {
          expect(warmup.integrations.find((row: { category: string }) => row.category === 'indexer')).toMatchObject({ indexStatus: 'reported-ready', indexObserved: true, queryObserved: true, indexedFiles: 1 });
          expect(f.graphCalls).toEqual(['cgc_index', 'cgc_query', 'cgc_query']);
          expect(f.graphSessions).toBeGreaterThanOrEqual(2);
        } else if (graph !== 'deferred') {
          expect(warmup.integrations.find((row: { category: string }) => row.category === 'indexer').indexStatus).toBe('unavailable');
          expect(stdout.indexOf('Warning: cgc warmup')).toBeLessThan(stdout.indexOf('Workload:'));
        }
        for (const row of warmup.integrations.filter((row: { category: string }) => row.category === 'tool')) {
          expect(row).not.toHaveProperty('indexStatus'); expect(row).not.toHaveProperty('indexedFiles');
        }
        for (const request of f.requests) {
          expect(request.max_tokens ?? request.max_completion_tokens).toBe(warmupTarget(request) === undefined ? 8192 : 4096);
          expect(request.reasoning?.enabled).not.toBe(false);
          expect(request.reasoning?.effort).not.toBe('none');
          if (harness === 'pi') {
            expect(request.provider?.require_parameters).toBe(true);
            expect(request.response_format?.type).toBe(warmupTarget(request) === undefined ? 'json_schema' : undefined);
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
        expect(result.tools.calls.reduce((n: number, call: { succeeded: number }) => n + call.succeeded, 0)).toBe(graph === 'codemode-ready' ? 5 : graph === 'ready' ? 4 : 3);
        const report = await readFile(join(output, 'reviews/native-tools.json'), 'utf8');
        expect(report).toContain('extra_ping');
        expect(JSON.parse(report).requestedMcp.find((row: { category: string }) => row.category === 'indexer').observation).toBe(graph === 'ready' || graph === 'codemode-ready' || graph === 'deferred' && harness === 'pi' ? 'observed' : 'not-observed');
        expect(JSON.parse(report).warmupReport).toBe('warmup.json');
        expect(report + stdout + stderr + JSON.stringify(result)).not.toContain(key);
      } finally { await f.close(); }
    }, 80000);
  }
});
}
