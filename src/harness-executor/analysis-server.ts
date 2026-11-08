/** Standard MCP stdio boundary. No model protocol, shell, installer or resource API. */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ANALYSIS_COMPONENTS, analysisTools, authorizeAnalysisCall, type AnalysisComponent } from './analysis-policy.ts';
import type { AnalysisBackend, AnalysisManifest, AnalysisSdk, IntegrationStatus } from './analysis.ts';

const execute = promisify(execFile);
interface Transport { readonly stderr?: { on(name: 'data', fn: (chunk: Buffer) => void): void } | null }
interface Client {
  connect(transport: Transport, options?: { timeout: number }): Promise<void>;
  listTools(): Promise<{ tools: readonly { name: string }[] }>;
  callTool(request: { name: string; arguments: Record<string, unknown> }, schema?: unknown, options?: { timeout: number }): Promise<unknown>;
  close(): Promise<void>;
}
interface Server {
  setRequestHandler(schema: unknown, handler: (request: unknown) => Promise<unknown>): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}
interface RuntimeSdk {
  readonly Client: new (identity: { name: string; version: string }, options: { capabilities: object }) => Client;
  readonly StdioClientTransport: new (options: { command: string; args: string[]; env: Record<string, string>; cwd: string; stderr: 'pipe' }) => Transport;
  readonly Server: new (identity: { name: string; version: string }, options: { capabilities: object }) => Server;
  readonly StdioServerTransport: new () => unknown;
  readonly ListToolsRequestSchema: unknown;
  readonly CallToolRequestSchema: unknown;
}
/** Reject malformed MCP records before reading upstream payload fields. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid MCP record');
  return value as Record<string, unknown>;
}
/** Load fixed trusted SDK modules and verify the required runtime exports before use. */
async function sdk(paths: AnalysisSdk): Promise<RuntimeSdk> {
  const modules: unknown[] = await Promise.all([paths.client, paths.clientTransport, paths.server, paths.serverTransport, paths.types]
    .map(path => import(pathToFileURL(path).href)));
  const merged = Object.assign({}, ...modules.map(record)) as Record<string, unknown>;
  for (const name of ['Client', 'StdioClientTransport', 'Server', 'StdioServerTransport']) {
    if (typeof merged[name] !== 'function') throw new Error('MCP SDK is incompatible');
  }
  if (merged['ListToolsRequestSchema'] === undefined || merged['CallToolRequestSchema'] === undefined) throw new Error('MCP schemas are unavailable');
  // Fixed exports from an already-installed trusted 1.x SDK; model data never selects this module.
  return merged as unknown as RuntimeSdk;
}
/** Connect an optional backend under its constructed environment and deadline; discard stderr and close failed clients. */
async function connect(runtime: RuntimeSdk, backend: AnalysisBackend): Promise<Client> {
  const client = new runtime.Client({ name: 'redline-readonly-analysis', version: '1.0.0' }, { capabilities: {} });
  const transport = new runtime.StdioClientTransport({ command: backend.command, args: [...backend.args],
    env: { ...backend.environment }, cwd: backend.environment['HOME'] ?? '/', stderr: 'pipe' });
  // Do not forward dependency stderr, source, credentials or reasoning into diagnostics.
  transport.stderr?.on('data', () => undefined);
  try { await client.connect(transport, { timeout: backend.component === 'cgc' ? 8000 : 5000 }); return client; }
  catch (error) { await client.close().catch(() => undefined); throw error; }
}
/** Keep bounded text-only upstream content and replace dependency errors with controller-owned fallback guidance. */
function result(value: unknown): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const row = record(value);
  if (row['isError'] === true) return { content: [{ type: 'text', text: 'Optional analysis dependency could not answer this scoped request. Continue with the captured review context.' }], isError: true };
  const chunks = Array.isArray(row['content']) ? row['content'].slice(0, 4) : [];
  const text = chunks.flatMap(chunk => {
    const c = record(chunk); return c['type'] === 'text' && typeof c['text'] === 'string' ? [c['text']] : [];
  }).join('\n');
  return { content: [{ type: 'text', text: Buffer.from(text, 'utf8').subarray(0, 16 * 1024).toString('utf8') }] };
}
/** Expose authorized tools only after readiness checks, without publishing backend launch configuration. */
function status(backend: AnalysisBackend, state: IntegrationStatus['status'], reason: string): IntegrationStatus {
  return { component: backend.component, status: state, reason, version: backend.version,
    tools: state === 'ready' ? analysisTools(backend.component).map(tool => tool.name) : [] };
}
/** Copy only authorized captured code into a bounded graph mirror, excluding configuration and credential paths. */
async function mirror(manifest: AnalysisManifest): Promise<number> {
  await mkdir(manifest.scope.graphSource, { recursive: true, mode: 0o700 });
  let bytes = 0, files = 0;
  for (const path of manifest.files) {
    if (files >= 100 || bytes >= 2 * 1024 * 1024) break;
    if (typeof path !== 'string' || path.split('/').some(part => ['.git', '.pi', '.opencode', 'node_modules'].includes(part) || part.startsWith('.env'))
      || !/\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|php|cs|cpp|c|h|hpp)$/u.test(path)) continue;
    try {
      const source = await authorizeAnalysisCall('context-mode', 'ctx_index', { path }, manifest.scope);
      const content = String(source['content']);
      if (bytes + Buffer.byteLength(content) > 2 * 1024 * 1024) continue;
      const target = join(manifest.scope.graphSource, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o400 });
      bytes += Buffer.byteLength(content); files += 1;
    } catch { /* Missing/unsupported capture is a coverage gap, never absence evidence. */ }
  }
  return files;
}
/** Run the installed graph provider against the mirror under bounded subprocess limits and check the pinned CGC version. */
async function index(backend: AnalysisBackend, manifest: AnalysisManifest): Promise<void> {
  if (backend.component !== 'cgc' && backend.component !== 'gitnexus') return;
  const args = backend.component === 'cgc' ? ['index', manifest.scope.graphSource, '--no-progress']
    : [backend.args[0] ?? '', 'analyze', manifest.scope.graphSource, '--index-only', '--skip-git', '--workers', '2'];
  if (backend.component === 'cgc') {
    const version = await execute(backend.command, ['--version'], { env: backend.environment, cwd: backend.environment['HOME'], timeout: 3000, maxBuffer: 32 * 1024 });
    if (!/\b0\.5\.7\b/u.test(version.stdout + version.stderr)) throw new Error('unsupported graph version');
  }
  await execute(backend.command, args, { env: backend.environment, cwd: backend.environment['HOME'], timeout: 12_000, maxBuffer: 64 * 1024 });
}
/** Verify optional backend indexing, catalogues, and queries; report sanitized failures and close every opened client. */
async function probe(manifest: AnalysisManifest, runtime: RuntimeSdk): Promise<void> {
  const files = await mirror(manifest);
  await Promise.all(manifest.backends.map(async backend => {
    let client: Client | undefined;
    let failureReason = 'probe-failed';
    try {
      if ((backend.component === 'cgc' || backend.component === 'gitnexus') && files === 0) {
        process.stdout.write(JSON.stringify(status(backend, 'disabled', 'no-captured-code')) + '\n'); return;
      }
      await index(backend, manifest);
      client = await connect(runtime, backend);
      const catalog = await client.listTools();
      if (analysisTools(backend.component).some(tool => !catalog.tools.some(available => available.name === tool.name))) throw new Error('required tools absent');
      if (backend.component === 'context-mode') {
        const path = manifest.scope.files?.[0];
        if (path === undefined) throw new Error('no captured source');
        const args = await authorizeAnalysisCall('context-mode', 'ctx_index', { path }, manifest.scope);
        const indexed = record(await client.callTool({ name: 'ctx_index', arguments: args }, undefined, { timeout: 4000 }));
        if (indexed['isError'] === true) throw new Error('captured indexing failed');
      }
      const args = backend.component === 'cgc' ? { repo_path: manifest.scope.graphSource }
        : backend.component === 'gitnexus' ? { search_query: 'redline-readiness-check', limit: 1 }
        : backend.component === 'context-mode' ? { queries: ['redline-readiness-check'], limit: 1 }
        : { thought: 'Check optional analysis readiness.', nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 };
      const name = backend.component === 'cgc' ? 'get_repository_stats' : backend.component === 'gitnexus' ? 'query'
        : backend.component === 'context-mode' ? 'ctx_search' : 'sequentialthinking';
      const reply = record(await client.callTool({ name, arguments: args }, undefined, { timeout: 4000 }));
      if (reply['isError'] === true) throw new Error('readiness query failed');
      if (backend.component === 'cgc') {
        failureReason = 'captured-index-unavailable';
        const content = Array.isArray(reply['content']) ? record(reply['content'][0]) : {};
        const data = record(JSON.parse(typeof content['text'] === 'string' ? content['text'] : '{}'));
        const stats = record(data['stats']);
        if (data['success'] !== true || typeof stats['files'] !== 'number' || stats['files'] < 1) throw new Error('captured graph is empty');
      }
      process.stdout.write(JSON.stringify(status(backend, 'ready', 'ready')) + '\n');
    } catch {
      process.stdout.write(JSON.stringify(status(backend, 'unusable', failureReason)) + '\n');
    } finally { await client?.close().catch(() => undefined); }
  }));
  if (manifest.pluginEntry !== null) {
    const backend = manifest.backends.find(item => item.component === 'context-mode');
    const home = backend?.environment['HOME'] ?? join(dirname(manifest.scope.graphSource), 'context-mode');
    try {
      const script = 'const m=await import(process.argv[1]);if(typeof m.default!=="function"&&typeof m.ContextModePlugin!=="function"&&typeof m.default?.server!=="function")process.exit(1)';
      const command = manifest.pluginEntry.endsWith('/pi/extension.js') ? process.execPath : backend?.command;
      if (command === undefined) throw new Error('plugin runtime absent');
      await execute(command, ['--input-type=module', '-e', script, pathToFileURL(manifest.pluginEntry).href], {
        env: backend?.environment ?? { HOME: home, USERPROFILE: home, TMP: home, TEMP: home, TMPDIR: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home, PATH: process.env.PATH ?? '' },
        cwd: home, timeout: 3000, maxBuffer: 32 * 1024,
      });
      process.stdout.write(JSON.stringify({ component: 'context-mode-plugin', status: 'ready', reason: 'loadable-not-activated', version: backend?.version ?? null, tools: [] }) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ component: 'context-mode-plugin', status: 'unusable', reason: 'plugin-unavailable', version: backend?.version ?? null, tools: [] }) + '\n');
    }
  }
}
/** Authorize bounded captured-source requests before lazily connecting the optional upstream MCP backend. */
async function serve(manifest: AnalysisManifest, component: AnalysisComponent, runtime: RuntimeSdk): Promise<void> {
  const backend = manifest.backends.find(item => item.component === component);
  if (backend === undefined) throw new Error('analysis backend not configured');
  // Frontend tool registration must not depend on optional backend startup.
  let client: Promise<Client> | undefined;
  const server = new runtime.Server({ name: 'redline-readonly-' + component, version: '1.0.0' }, { capabilities: { tools: {} } });
  let calls = 0;
  server.setRequestHandler(runtime.ListToolsRequestSchema, async () => ({ tools: analysisTools(component) }));
  server.setRequestHandler(runtime.CallToolRequestSchema, async request => {
    try {
      if (++calls > 32) throw new Error('analysis call bound exhausted');
      const params = record(record(request)['params']);
      if (typeof params['name'] !== 'string') throw new Error('invalid analysis tool');
      const args = await authorizeAnalysisCall(component, params['name'], params['arguments'] ?? {}, manifest.scope);
      const upstream = await (client ??= connect(runtime, backend));
      return result(await upstream.callTool({ name: params['name'], arguments: args }, undefined, { timeout: 5000 }));
    } catch {
      return { content: [{ type: 'text', text: 'Analysis request denied or optional dependency unavailable. Continue the review using captured context.' }], isError: true };
    }
  });
  let closed = false;
  /** Make signal and stdin cleanup idempotent and close both upstream and frontend connections. */
  const close = async (): Promise<void> => {
    if (closed) return; closed = true;
    await client?.then(value => value.close()).catch(() => undefined); await server.close().catch(() => undefined);
  };
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  process.stdin.once('end', () => { void close(); });
  await server.connect(new runtime.StdioServerTransport());
}
/** Manifest is private controller output, never a model/repository-selected command. */
export async function main(): Promise<number> {
  try {
    const [mode, file, component] = process.argv.slice(2);
    if (!['probe', 'serve'].includes(mode ?? '') || file === undefined || !isAbsolute(file)) throw new Error('invalid analysis invocation');
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    const row = record(value);
    if (row['version'] !== 1 || !Array.isArray(row['backends']) || !Array.isArray(row['files'])) throw new Error('invalid analysis manifest');
    // The manifest file is generated mode0600 outside captured source by prepareAnalysis.
    const manifest = row as unknown as AnalysisManifest;
    const runtime = await sdk(manifest.sdk);
    if (mode === 'probe') await probe(manifest, runtime);
    else {
      if (!ANALYSIS_COMPONENTS.includes(component as AnalysisComponent)) throw new Error('unknown analysis component');
      await serve(manifest, component as AnalysisComponent, runtime);
    }
    return 0;
  } catch { process.stderr.write('Optional analysis integration unavailable.\n'); return 1; }
}
