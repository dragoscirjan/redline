/** Optional, credential-free analysis discovery. Never installs or loads user config. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYSIS_COMPONENTS, analysisTools, authorizeAnalysisCall, type AnalysisComponent, type AnalysisScope } from './analysis-policy.ts';
import { cgcGrammarEnvironment, CGC_GRAMMAR_VERSION, CGC_GRAMMAR_MANIFEST_SHA256, locateCgcGrammars } from '../code-index/cgc-grammars.ts';
import { nodeProcessSpawner, runBoundedProcess } from './process-runner.ts';

export interface AnalysisRequest {
  readonly sourceDirectory: string;
  readonly repositoryDirectory?: string;
  readonly files: readonly string[];
  readonly head: string;
  readonly graphEnabled: boolean;
  readonly timeoutMs: number;
}
export interface IntegrationStatus {
  readonly component: AnalysisComponent | 'context-mode-plugin';
  readonly status: 'ready' | 'missing' | 'unusable' | 'disabled';
  readonly reason: string;
  readonly version: string | null;
  readonly tools: readonly string[];
}
export interface AnalysisSdk {
  readonly client: string;
  readonly clientTransport: string;
  readonly server: string;
  readonly serverTransport: string;
  readonly types: string;
}
export interface AnalysisBackend {
  readonly component: AnalysisComponent;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly version: string;
}
export interface AnalysisManifest {
  readonly version: 1;
  readonly scope: AnalysisScope;
  readonly files: readonly string[];
  readonly sdk: AnalysisSdk;
  readonly backends: readonly AnalysisBackend[];
  readonly pluginEntry: string | null;
}
export interface PreparedAnalysis {
  readonly manifestFile: string;
  readonly command: string;
  readonly launcher: string;
  readonly statuses: readonly IntegrationStatus[];
  readonly backends: readonly AnalysisComponent[];
  readonly identity?: string;
  readonly cgcSocketPath?: string;
}
const versions = { 'context-mode': '1.0.169', gitnexus: '1.6.12', 'sequential-thinking': '2.0.0', cgc: '0.5.7' };
const launcher = fileURLToPath(new URL('../../bin/redline-analysis.mjs', import.meta.url));
const ownedSocketPaths = new Set<string>();
/** Compare canonical path components without accepting similarly named sibling directories. */
function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..' + sep) && value !== '..' && !isAbsolute(value));
}
/** Reject both lexical and canonical paths inside reviewed roots; unavailable paths are not trusted dependency candidates. */
async function permitted(path: string, blocked: readonly string[]): Promise<string | undefined> {
  if (blocked.some(root => inside(root, resolve(path)))) return undefined;
  try {
    const canonical = await realpath(path);
    if (blocked.some(root => inside(root, canonical))) return undefined;
    return canonical;
  } catch { return undefined; }
}
/** Search absolute trusted PATH entries outside reviewed roots without invoking an installer. */
async function executable(name: string, blocked: readonly string[]): Promise<string | undefined> {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    for (const suffix of suffixes) {
      const path = await permitted(join(folder, name + suffix), blocked);
      if (path === undefined) continue;
      try { await access(path, constants.X_OK); return path; } catch { /* Other trusted PATH entries may work. */ }
    }
  }
  return undefined;
}
/** Read bounded installed-package metadata outside blocked roots and accept only the expected identity and a bounded version. */
async function packageAt(roots: readonly string[], name: string, blocked: readonly string[]) {
  for (const root of roots) {
    const path = await permitted(join(root, name, 'package.json'), blocked);
    if (path === undefined) continue;
    try {
      if ((await stat(path)).size > 64 * 1024) continue;
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (value === null || typeof value !== 'object' || !('name' in value) || value.name !== name
        || !('version' in value) || typeof value.version !== 'string' || value.version.length > 64 || !/^[\d.]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(value.version)) continue;
      return { path, root: dirname(path), version: value.version };
    } catch { /* A missing or incompatible optional package must not stop review. */ }
  }
  return undefined;
}
/** Resolve the fixed MCP SDK entrypoints from installed packages, rejecting any entry that resolves into reviewed source. */
async function sdkAt(packages: readonly (string | undefined)[], blocked: readonly string[]): Promise<AnalysisSdk | undefined> {
  for (const path of packages) {
    if (path === undefined) continue;
    try {
      const require = createRequire(path);
      const names = { client: 'client/index.js', clientTransport: 'client/stdio.js', server: 'server/index.js',
        serverTransport: 'server/stdio.js', types: 'types.js' };
      const result: Record<string, string> = {};
      for (const [key, entry] of Object.entries(names)) {
        const value = await permitted(require.resolve('@modelcontextprotocol/sdk/' + entry), blocked);
        if (value === undefined) throw new Error('untrusted SDK path');
        result[key] = value;
      }
      // All five fixed keys above have resolved outside the untrusted roots.
      return result as unknown as AnalysisSdk;
    } catch { /* Try another already-installed package, never an installer. */ }
  }
  return undefined;
}
function status(component: IntegrationStatus['component'], state: IntegrationStatus['status'], reason: string, version: string | null = null): IntegrationStatus {
  return { component, status: state, reason, version, tools: [] };
}
/** The saved projection contains no commands, host paths, credentials or raw errors. */
function checkedStatus(value: unknown): IntegrationStatus | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (![...ANALYSIS_COMPONENTS, 'context-mode-plugin'].includes(String(row['component']))
    || !['ready', 'missing', 'unusable', 'disabled'].includes(String(row['status']))
    || typeof row['reason'] !== 'string' || !/^[a-z-]{1,64}$/u.test(row['reason'])
    || !(row['version'] === null || typeof row['version'] === 'string' && /^[\d.]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(row['version']))
    || !Array.isArray(row['tools']) || row['tools'].some(tool => typeof tool !== 'string' || !/^[a-z_]{1,64}$/u.test(tool))) return undefined;
  return row as unknown as IntegrationStatus;
}

/** Keep resolved UTF-8 paths below macOS's 104-byte Unix socket limit. */
export async function createAnalysisSocketPath(): Promise<string> {
  let base = await realpath(tmpdir());
  const fits = (directory: string): boolean => Buffer.byteLength(join(directory, 'rl-mcp-XXXXXX', 'f.sock')) <= 100;
  if (!fits(base) && process.platform !== 'win32') base = await realpath('/tmp');
  if (!fits(base)) throw new Error('no short analysis socket directory');
  const path = join(await mkdtemp(join(base, 'rl-mcp-')), 'f.sock');
  ownedSocketPaths.add(path);
  return path;
}

/** Resolve pinned optional dependencies and probe them against bounded captured source while retaining ownership of temporary sockets. */
async function prepareChecked(request: AnalysisRequest | undefined, workDirectory: string, harness: 'pi' | 'opencode', harnessCommand: string, onSocketPath: (path: string) => void): Promise<PreparedAnalysis | undefined> {
  if (request === undefined) return undefined;
  const deadline = performance.now() + Math.max(0, Math.min(20_000, request.timeoutMs));
  const remaining = (): number => Math.max(1, Math.floor(deadline - performance.now()));
  const root = join(workDirectory, 'analysis'); await mkdir(root, { recursive: true, mode: 0o700 });
  const blocked = [await realpath(request.sourceDirectory)];
  if (request.repositoryDirectory !== undefined) blocked.push(await realpath(request.repositoryDirectory));
  const node = await executable('node', blocked);
  const roots = ['/opt/harness/node_modules', join(dirname(process.execPath), '../lib/node_modules'),
    join(homedir(), '.pi/agent/npm/node_modules'), join(homedir(), '.config/opencode/node_modules'), join(homedir(), '.cache/opencode/node_modules')];
  if (node !== undefined) roots.push(join(dirname(node), '../lib/node_modules'));
  const harnessPath = isAbsolute(harnessCommand) ? await permitted(harnessCommand, blocked) : await executable(harnessCommand, blocked);
  let ancestor = harnessPath === undefined ? '' : dirname(harnessPath);
  for (let depth = 0; ancestor !== '' && depth < 10; depth += 1) {
    if (ancestor.endsWith(sep + 'node_modules')) roots.push(ancestor);
    const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  const context = await packageAt(roots, 'context-mode', blocked);
  const gitnexus = await packageAt(roots, 'gitnexus', blocked);
  const thinking = await packageAt(roots, '@modelcontextprotocol/server-sequential-thinking', blocked);
  const pi = await packageAt(roots, '@earendil-works/pi-coding-agent', blocked);
  const sdk = await sdkAt([context?.path, thinking?.path, gitnexus?.path, pi?.path], blocked);
  const bun = await executable('bun', blocked);
  const cgc = await executable('cgc', blocked);
  const initial = new Map<IntegrationStatus['component'], IntegrationStatus>();
  const harnessVersion = await runBoundedProcess(nodeProcessSpawner, { command: harnessCommand, args: ['--version'], cwd: root,
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMP: root, TEMP: root, PI_CODING_AGENT_DIR: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root,
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }) },
    stdin: '', timeoutMs: Math.min(2000, remaining()), stdoutLimitBytes: 16 * 1024 });
  const expectedHarness = harness === 'pi' ? /(?:^|\s)v?1\.4\.0(?:\s|$)/u : /(?:^|\s)v?1\.18\.34(?:\s|$)/u;
  if (harnessVersion.code !== 0 || !expectedHarness.test(harnessVersion.stdout)) {
    return { manifestFile: '', command: node ?? process.execPath, launcher,
      statuses: [...ANALYSIS_COMPONENTS.map(component => status(component, 'unusable', 'unsupported-harness')), status('context-mode-plugin', 'disabled', 'unsupported-harness')], backends: [] };
  }
  const safePath = (await Promise.all((process.env.PATH ?? '').split(delimiter)
    .filter(folder => isAbsolute(folder)).map(folder => permitted(folder, blocked))))
    .filter((folder): folder is string => folder !== undefined).join(delimiter);
  const grammars = await locateCgcGrammars(blocked);
  const backends: AnalysisBackend[] = [];
  for (const component of ANALYSIS_COMPONENTS) {
    const installed = component === 'context-mode' ? context : component === 'gitnexus' ? gitnexus : component === 'sequential-thinking' ? thinking : undefined;
    const home = join(root, component); await mkdir(home, { recursive: true, mode: 0o700 });
    const environment: Record<string, string> = { HOME: home, USERPROFILE: home, TMP: home, TEMP: home, PATH: safePath, LANG: 'C.UTF-8',
      TMPDIR: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
      DISABLE_THOUGHT_LOGGING: 'true', CGC_IGNORE_PROJECT_ENV: '1', ENABLE_AUTO_WATCH: 'false',
      SCIP_INDEXER: 'false', SKIP_EXTERNAL_RESOLUTION: 'true', INDEX_SOURCE: 'false', PARALLEL_WORKERS: '2',
      CONTEXT_MODE_PROJECT_DIR: home, GITNEXUS_HOME: home, GITNEXUS_STORAGE_PATH: join(home, 'database'), GITNEXUS_EMBEDDING_MODE: 'disabled' };
    if (process.platform === 'win32' && process.env.SystemRoot !== undefined) environment['SystemRoot'] = process.env.SystemRoot;
    const available = component === 'cgc' ? cgc !== undefined : installed !== undefined;
    if (!available) { initial.set(component, status(component, 'missing', 'not-installed')); continue; }
    if (installed !== undefined && component !== 'sequential-thinking' && installed.version !== versions[component]) {
      initial.set(component, status(component, 'unusable', 'unsupported-version', installed.version)); continue;
    }
    if (node === undefined || sdk === undefined || component === 'context-mode' && bun === undefined) {
      initial.set(component, status(component, 'unusable', 'missing-runtime', installed?.version ?? null)); continue;
    }
    if ((component === 'cgc' || component === 'gitnexus') && !request.graphEnabled) {
      initial.set(component, status(component, 'disabled', 'indexing-disabled', installed?.version ?? null)); continue;
    }
    let command: string = node;
    let args: string[];
    if (component === 'cgc') {
      if (grammars === undefined) { initial.set(component, status(component, 'missing', 'parsers-not-installed', versions.cgc)); continue; }
      command = cgc as string; args = ['mcp', 'start'];
      Object.assign(environment, cgcGrammarEnvironment(home, grammars));
      const database = join(home, 'database'); await mkdir(database, { recursive: true, mode: 0o700 });
      let socketPath: string;
      try { socketPath = await createAnalysisSocketPath(); onSocketPath(socketPath); }
      catch { initial.set(component, status(component, 'unusable', 'socket-unavailable', versions.cgc)); continue; }
      Object.assign(environment, { CGC_RUNTIME_DB_TYPE: 'falkordb', CGC_RUNTIME_DB_PATH: join(database, 'falkordb.db'),
        DEFAULT_DATABASE: 'falkordb', FALKORDB_PATH: join(database, 'falkordb.db'), FALKORDB_SOCKET_PATH: socketPath,
        NO_COLOR: '1', COLUMNS: '65536', IGNORE_TEST_FILES: 'false' });
    } else if (component === 'context-mode') { command = bun as string; args = [join(context?.root ?? '', 'cli.bundle.mjs')]; }
    else args = [component === 'gitnexus' ? join(gitnexus?.root ?? '', 'dist/cli/index.js') : join(thinking?.root ?? '', 'dist/index.js'), ...(component === 'gitnexus' ? ['mcp'] : [])];
    if (args.length > 0 && isAbsolute(args[0] ?? '') && await permitted(args[0] ?? '', blocked) === undefined) {
      initial.set(component, status(component, 'unusable', 'entry-missing', installed?.version ?? null)); continue;
    }
    backends.push({ component, command, args, environment, version: installed?.version ?? versions.cgc });
  }
  const pluginEntry = context?.version !== versions['context-mode'] ? null
    : await permitted(join(context.root, 'build/adapters', harness, harness === 'pi' ? 'extension.js' : 'plugin.js'), blocked) ?? null;
  const unsupportedPlugin = context !== undefined && context.version !== versions['context-mode'];
  initial.set('context-mode-plugin', status('context-mode-plugin', unsupportedPlugin ? 'unusable' : pluginEntry === null ? 'missing' : 'disabled',
    unsupportedPlugin ? 'unsupported-version' : pluginEntry === null ? 'not-installed' : 'native-mcp-integration', context?.version ?? null));
  if (sdk === undefined || node === undefined) {
    for (const component of ANALYSIS_COMPONENTS) if (!initial.has(component)) initial.set(component, status(component, 'unusable', 'missing-runtime'));
    return { manifestFile: '', command: node ?? process.execPath, launcher, statuses: [...initial.values()], backends: [] };
  }
  const sourceScope: AnalysisScope = { source: request.sourceDirectory, graphSource: join(root, 'captured'), sourceLabel: 'captured-' + request.head };
  const files: string[] = [];
  const sourceHash = createHash('sha256').update(JSON.stringify({
    policy: 'captured-analysis-v1', nativeRequestTimeoutMs: 15000, platform: process.platform, architecture: process.arch,
    grammars: [CGC_GRAMMAR_VERSION, CGC_GRAMMAR_MANIFEST_SHA256],
    tools: ANALYSIS_COMPONENTS.map(component => analysisTools(component)),
  }));
  let sourceBytes = 0;
  for (const path of [...new Set(request.files)].sort().slice(0, 200)) {
    if (performance.now() >= deadline) break;
    try {
      const selected = await authorizeAnalysisCall('context-mode', 'ctx_index', { path }, sourceScope);
      const text = String(selected['content']); const bytes = Buffer.byteLength(text);
      if (sourceBytes + bytes > 2 * 1024 * 1024) continue;
      files.push(path); sourceBytes += bytes; sourceHash.update(path).update('\0').update(text).update('\0');
    } catch { /* Unavailable capture is not an authorized analysis input. */ }
  }
  const manifest: AnalysisManifest = { version: 1, scope: { ...sourceScope, files }, files, sdk, backends, pluginEntry };
  const manifestFile = join(root, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  const probe = await runBoundedProcess(nodeProcessSpawner, { command: node, args: [launcher, 'probe', manifestFile], cwd: root,
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMP: root, TEMP: root, TMPDIR: root, ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }) },
    stdin: '', timeoutMs: remaining(), stdoutLimitBytes: 64 * 1024 });
  for (const line of probe.stdout.split('\n')) {
    try { const row = checkedStatus(JSON.parse(line)); if (row !== undefined) initial.set(row.component, row); } catch { /* No raw optional-server output is trusted. */ }
  }
  for (const backend of backends) if (!initial.has(backend.component)) {
    initial.set(backend.component, status(backend.component, 'unusable', probe.timedOut ? 'probe-timeout' : 'probe-failed', backend.version));
  }
  const statuses = [...ANALYSIS_COMPONENTS, 'context-mode-plugin' as const].map(component => initial.get(component))
    .filter((row): row is IntegrationStatus => row !== undefined);
  return { manifestFile, command: node, launcher, statuses,
    identity: sourceHash.update(JSON.stringify(statuses.filter(row => row.component !== 'context-mode-plugin' && row.status === 'ready'))).digest('hex'),
    backends: ANALYSIS_COMPONENTS.filter(component => statuses.some(row => row.component === component && row.status === 'ready')) };
}

/** Contain optional setup failures, release any allocated socket, and return explicit unavailable integration coverage. */
export async function prepareAnalysis(request: AnalysisRequest | undefined, workDirectory: string, harness: 'pi' | 'opencode', command: string): Promise<PreparedAnalysis | undefined> {
  let socketPath: string | undefined;
  try {
    const prepared = await prepareChecked(request, workDirectory, harness, command, path => { socketPath = path; });
    return prepared === undefined || socketPath === undefined ? prepared : { ...prepared, cgcSocketPath: socketPath };
  } catch {
    await disposeSocket(socketPath);
    return request === undefined ? undefined : { manifestFile: '', command: process.execPath, launcher,
      statuses: [...ANALYSIS_COMPONENTS.map(component => status(component, 'unusable', 'setup-unavailable')), status('context-mode-plugin', 'unusable', 'setup-unavailable')], backends: [] };
  }
}

/** Generate harness-specific MCP launch configuration only for ready, controller-owned analysis backends. */
export function integrationServers(analysis: PreparedAnalysis | undefined, harness: 'pi' | 'opencode'): Record<string, unknown> {
  return Object.fromEntries((analysis?.backends ?? []).map(component => {
    const value = analysis as PreparedAnalysis;
    const name = 'redline_' + component.replaceAll('-', '_');
    const args = [value.launcher, 'serve', value.manifestFile, component];
    const environment = { REDLINE_MODEL_API_KEY: '', PI_CODING_AGENT_DIR: '', OPENCODE_CONFIG: '', NODE_OPTIONS: '', HOME: dirname(value.manifestFile), USERPROFILE: dirname(value.manifestFile), TMP: dirname(value.manifestFile), TEMP: dirname(value.manifestFile) };
    return [name, harness === 'pi' ? { command: value.command, args, env: environment, cwd: dirname(value.manifestFile),
      timeout: 15, exposure: 'hidden', description: 'Bounded captured-source analysis only.',
      toolExposure: Object.fromEntries(analysisTools(component).map(tool => [tool.name, 'direct'])) }
      : { type: 'local', command: [value.command, ...args], environment, enabled: true, timeout: 15000 }];
  }));
}

/** Stop only sockets allocated by this controller and bound shutdown before removing their owned temporary directory. */
async function disposeSocket(path: string | undefined): Promise<void> {
  if (path === undefined || !ownedSocketPaths.delete(path)) return;
  await new Promise<void>(done => {
    const socket = connect({ path });
    const finish = (): void => { socket.destroy(); done(); };
    socket.setTimeout(500, finish); socket.once('error', finish); socket.once('close', done);
    socket.once('connect', () => socket.end('*2\r\n$8\r\nSHUTDOWN\r\n$6\r\nNOSAVE\r\n'));
  });
  await rm(dirname(path), { recursive: true, force: true }).catch(() => undefined);
}

/** Stop this run's embedded database and remove its owned socket directory. */
export async function disposeAnalysis(analysis: PreparedAnalysis | undefined): Promise<void> {
  await disposeSocket(analysis?.cgcSocketPath);
}

/** Translate the ready backend allowlist into each harness's exact tool-name namespace. */
export function integrationToolNames(analysis: PreparedAnalysis | undefined, harness: 'pi' | 'opencode'): string[] {
  return (analysis?.backends ?? []).flatMap(component => analysisTools(component).map(tool =>
    harness === 'pi' ? 'mcp__redline_' + component.replaceAll('-', '_') + '__' + tool.name
      : 'redline_' + component.replaceAll('-', '_') + '_' + tool.name));
}
