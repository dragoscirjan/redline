import { execFileSync, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EOL, tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/local/cli.ts';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { loadReviewCodeContext, codeContextForFile } from '../src/review/indexed-context.ts';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { buildFileReviewPrompt } from '../src/review/prompt.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(xdgCache = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'redline-context-test-'))); roots.push(root);
  const repository = join(root, 'repo'); await mkdir(join(repository, 'src'), { recursive: true }); await mkdir(join(repository, 'test'));
  const env = { PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
    HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    ...(xdgCache ? { XDG_CACHE_HOME: join(root, 'cache-volume') } : {}),
    GH_TOKEN: 'must-not-reach-indexer', OPENROUTER_API_KEY: 'must-not-reach-indexer' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git('init', '--quiet', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@localhost');
  await writeFile(join(repository, 'src/service.ts'), 'export function normalize(input: string) { return input; }\n');
  await writeFile(join(repository, 'test/service.test.ts'), "import { normalize } from '../src/service';\n// TEST_CONTRACT_SENTINEL\nexport function testContract() { return normalize('value'); }\n");
  await writeFile(join(repository, '.cgcignore'), '**\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'src/service.ts'), 'export function normalize(input: string) { return input.trim(); }\n');
  git('commit', '--quiet', '-am', 'head');
  const provider = join(root, 'fake-cgc.mjs');
  const calls = join(root, 'calls.jsonl');
  await writeFile(provider, `import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2);
if(process.env.GH_TOKEN || process.env.OPENROUTER_API_KEY || process.env.REDLINE_MODEL_AUTH || process.env.REDLINE_PUBLISH_TOKEN) process.exit(91);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if(args[0]==='version') {console.error('CodeGraphContext 0.5.7'); process.exit(0);}
const database=process.env.CGC_RUNTIME_DB_PATH;
if(args[0]==='index') {
 if(fs.existsSync(path.join(args[1],'.cgcignore')) || fs.existsSync(path.join(args[1],'.git'))) process.exit(92);
 fs.mkdirSync(path.dirname(database),{recursive:true}); fs.writeFileSync(database,JSON.stringify({root:args[1]})); process.exit(0);
}
if(args[0]==='query') {
 if(process.env.COLUMNS!=='65536' || process.env.NO_COLOR!=='1' || process.env.TERM!=='dumb') process.exit(94);
 const data=JSON.parse(fs.readFileSync(database,'utf8'));
 if(args[1].includes('repository_count')) console.log('[{"repository_count":1}]');
 else if(args[1].startsWith('MATCH (related)')) console.log(JSON.stringify([{changed_path:path.join(data.root,'src/service.ts'),related_path:path.join(data.root,'test/service.test.ts'),start_line:1,end_line:3}]));
 else console.log('[]');
} else process.exit(93);
`);
  let counter = 0;
  const run = async (extra: string[] = [], managed = false) => {
    const output = join(root, `output-${counter++}`); const stdout: string[] = []; const stderr: string[] = [];
    const code = await main(['review', '--repository', repository, '--harness', 'echo', '--base', base, '--head', 'HEAD',
      '--output', output, ...(managed ? [] : ['--index-executable', provider]), ...extra], env, {
      cwd: root, stdout: (line) => { stdout.push(line); }, stderr: (line) => { stderr.push(line); },
    });
    return { code, output, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  };
  return { root, repository, base, env, git, provider, calls, run };
}

async function summary(output: string) { return JSON.parse(await readFile(join(output, 'reviews/summary.json'), 'utf8')); }

describe('local indexed-context parity', () => {
  it('retains provider data under XDG_CACHE_HOME independently of per-run state', async () => {
    const f = await fixture(true);
    const first = await f.run(['--indexing', 'required']); expect(first.code, first.stderr).toBe(0);
    const second = await f.run(['--indexing', 'required']); expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain('Base index: reused');
    const entries = await readdir(join(f.root, 'cache-volume/redline/indexes/v1'));
    const key = entries.find(name => /^[a-f0-9]{64}$/u.test(name));
    expect(key).toBeDefined();
    const metadata = JSON.parse(await readFile(join(f.root, 'cache-volume/redline/indexes/v1', key!, 'entry.json'), 'utf8'));
    expect(JSON.parse(metadata.identity).provider).toBe('cgc');
    expect(await readdir(join(f.root, 'state/redline/indexes')).catch(() => [])).toEqual([]);
  });

  it('reuses the base database across repeated runs, token budgets, and head changes while refreshing head evidence', async () => {
    const f = await fixture(); const first = await f.run(['--indexing', 'required']); expect(first.code, first.stderr).toBe(0);
    const second = await f.run(['--indexing', 'required', '--max-output-tokens', '32768']); expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain('Base index: reused');
    expect((await summary(second.output)).codeContext.timings.indexMs).toBe(0);
    const test = join(f.repository, 'test/service.test.ts');
    await writeFile(test, (await readFile(test, 'utf8')).replace('TEST_CONTRACT_SENTINEL', 'FRESH_HEAD_CONTRACT'));
    f.git('commit', '--quiet', '-am', 'changed head');
    const third = await f.run(); expect(third.code, third.stderr).toBe(0); expect(third.stderr).toContain('Base index: reused');
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === 'index')).toHaveLength(1);
    const capture = JSON.parse(await readFile(join(third.output, 'capture.json'), 'utf8'));
    const bundle = await loadReviewBundle(join(third.output, 'bundle'), join(third.output, 'source'));
    const indexed = await loadReviewCodeContext(bundle, { path: join(third.output, 'index/code-context.json'), repository: capture.repositoryIdentity });
    const file = bundle.manifest.files.find((item) => item.newPath === 'src/service.ts')!;
    expect(codeContextForFile(indexed, file).prompt?.related[0]?.content).toContain('FRESH_HEAD_CONTRACT');
    expect((await summary(third.output)).codeContext.revision).toBe(f.git('rev-parse', 'HEAD'));
  });

  it('rebuilds when the base changes or retained database validation fails, but refreshes base source without trusting cached bytes', async () => {
    const f = await fixture(); expect((await f.run()).code).toBe(0);
    const root = join(f.root, 'state/redline/indexes/v1'); const key = (await readdir(root)).find((name) => /^[a-f0-9]{64}$/u.test(name))!;
    await writeFile(join(root, key, 'base/src/service.ts'), 'UNTRUSTED_CACHED_SOURCE\n');
    const healthy = await f.run(); expect(healthy.code, healthy.stderr).toBe(0); expect(healthy.stderr).toContain('Base index: reused');
    expect(await readFile(join(root, key, 'base/src/service.ts'), 'utf8')).toContain('return input;');
    await writeFile(join(root, key, 'cache/database/falkordb.db'), 'corrupted database');
    const repaired = await f.run(); expect(repaired.code, repaired.stderr).toBe(0);
    expect((await summary(repaired.output)).codeContext.diagnosticCodes).toContain('cache-restore-invalid');
    const nextBase = f.git('rev-parse', 'HEAD');
    await writeFile(join(f.repository, 'src/service.ts'), 'export function normalize(input: string) { return input.toUpperCase(); }\n'); f.git('commit', '--quiet', '-am', 'next head');
    const changed = await f.run(['--base', nextBase]); expect(changed.code, changed.stderr).toBe(0); expect(changed.stderr).toContain('Base index: rebuilt');
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === 'index')).toHaveLength(3);
  });

  it('serializes concurrent cache users instead of indexing the same base twice', async () => {
    const f = await fixture(); const results = await Promise.all([f.run(), f.run()]);
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    expect(results.some((result) => result.stderr.includes('Base index: reused'))).toBe(true);
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === 'index')).toHaveLength(1);
  });
  it.runIf(process.env.REDLINE_LIVE_LOCAL_CONTEXT_TESTS === '1' && process.platform === 'linux' && process.arch === 'x64')('uses the real separately provisioned pinned CGC on an isolated fixture', async () => {
    const f = await fixture();
    const provider = process.env.REDLINE_LIVE_CGC_EXECUTABLE;
    expect(provider).toBeTruthy();
    const managed = join(f.root, 'state/redline/tools/cgc/0.5.7/linux-x64/cgc');
    await mkdir(join(f.root, 'state/redline/tools/cgc/0.5.7/linux-x64'), { recursive: true });
    await copyFile(provider!, managed);
    const result = await f.run(['--indexing', 'required'], true);
    const status = await readFile(join(result.output, 'index/status.json'), 'utf8').catch(() => 'no context status');
    console.log(`Live pinned context: ${status.replaceAll('\n', ' ')}`);
    expect(result.code, `${result.stderr}\n${status}`).toBe(0);
    const report = await summary(result.output);
    expect(['complete', 'partial']).toContain(report.codeContext.status);
    expect(report.codeContext.provider).toEqual({ id: 'cgc', version: '0.5.7' });
    expect(report.codeContext.relatedSpans).toBeGreaterThan(0);
    const warm = await f.run(['--indexing', 'required'], true);
    expect(warm.code, warm.stderr).toBe(0); expect(warm.stderr).toContain('Base index: reused');
    expect((await summary(warm.output)).codeContext.timings.indexMs).toBe(0);
    console.log('Real pinned CGC warm reuse: validated base database; indexMs=0');
  }, 180_000);
  it('uses the shared builder and supplies source-validated tests to the same prompt as the action', async () => {
    const f = await fixture(); const result = await f.run(['--indexing', 'required']);
    expect(result.code, result.stderr).toBe(0);
    const report = await summary(result.output);
    expect(report.codeContext.status).toBe('complete'); expect(report.codeContext.relatedSpans).toBe(1);
    expect(result.stdout).toMatch(/Indexed context:\s+complete/u);
    expect(result.stdout).toMatch(/Related source:\s+1 file with context; 1 related span/u);
    expect(result.stdout).toMatch(/Provider:\s+cgc 0\.5\.7/u);
    const capture = JSON.parse(await readFile(join(result.output, 'capture.json'), 'utf8'));
    expect(capture.repositoryIdentity).toMatch(/^local\/[a-f0-9]{64}$/u);
    const path = join(result.output, 'index/code-context.json');
    const bundle = await loadReviewBundle(join(result.output, 'bundle'), join(result.output, 'source'));
    const artifact = JSON.parse(await readFile(path, 'utf8'));
    expect(artifact.baseRevision).toBe(f.base); expect(artifact.revision).toBe(capture.head);
    const indexed = await loadReviewCodeContext(bundle, { path, repository: capture.repositoryIdentity });
    const file = bundle.manifest.files.find((item) => item.newPath === 'src/service.ts')!;
    const context = codeContextForFile(indexed, file).prompt;
    const local = await buildFileReviewPrompt({ bundle, file, indexedContext: context, findingScope: 'defects', harness: 'echo', model: 'echo' });
    const actionEnvironment = parseReviewEnvironment({ REDLINE_HARNESS: 'echo', REDLINE_REVIEW_DIR: bundle.root, REDLINE_SOURCE_DIR: bundle.sourceRoot,
      REDLINE_OUTPUT_DIR: result.output, REDLINE_MODEL_CONFIG: '{"provider":"mock","endpoint":"http://127.0.0.1:1/v1","model":"echo","auth":"none"}',
      REDLINE_FINDING_SCOPE: 'defects', REDLINE_CODE_CONTEXT: path, REDLINE_CODE_CONTEXT_REPOSITORY: capture.repositoryIdentity }).review!;
    const actionContext = await loadReviewCodeContext(bundle, actionEnvironment.codeContext);
    const action = await buildFileReviewPrompt({ bundle, file, indexedContext: codeContextForFile(actionContext, file).prompt,
      findingScope: actionEnvironment.findingScope, harness: actionEnvironment.harness, model: actionEnvironment.model.model });
    expect(local.user).toContain('TEST_CONTRACT_SENTINEL'); expect(local.user).toBe(action.user); expect(local.system).toBe(action.system);
    expect(await readFile(join(result.output, 'index/home/config'), 'utf8').catch(() => null)).toBeNull();
    expect((await readFile(f.calls, 'utf8')).split('\n').filter(Boolean)).toHaveLength(5);
  });

  it.each(['staged', 'unstaged', 'all'])('binds %s context to synthetic captured revisions without changing the original index', async (mode) => {
    const f = await fixture();
    await writeFile(join(f.repository, 'src/service.ts'), 'export function normalize(input: string) { return input.toLowerCase(); }\n');
    f.git('add', 'src/service.ts');
    await writeFile(join(f.repository, 'src/service.ts'), 'export function normalize(input: string) { return input.toUpperCase(); }\n');
    const before = await readFile(join(f.repository, '.git/index'));
    const result = await f.run(['--head', 'HEAD']); // committed mode remains independent of the dirty file
    expect(result.code, result.stderr).toBe(0);
    const output = join(f.root, 'working');
    const code = await main(['review', '--repository', f.repository, '--harness', 'echo', '--worktree', mode!, '--indexing', 'required',
      '--index-executable', f.provider, '--output', output], f.env, { cwd: f.root, stdout: () => {}, stderr: () => {} });
    expect(code).toBe(0);
    const capture = JSON.parse(await readFile(join(output, 'capture.json'), 'utf8'));
    expect(capture.head).not.toBe(f.git('rev-parse', 'HEAD'));
    expect((await summary(output)).codeContext.revision).toBe(capture.head);
    expect(await readFile(join(output, 'source/src/service.ts'), 'utf8')).toContain(mode === 'staged' ? 'toLowerCase' : 'toUpperCase');
    expect(JSON.parse(await readFile(join(output, 'index/code-context.json'), 'utf8')).baseRevision).toBe(capture.base);
    expect(await readFile(join(f.repository, '.git/index'))).toEqual(before);
  });

  it('orchestrates the pinned GitNexus adapter with a fake backend', async () => {
    const f = await fixture(); const root = join(f.root, 'gitnexus');
    await mkdir(join(root, 'dist/cli'), { recursive: true }); await mkdir(join(root, 'dist/mcp/local'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const cli = join(root, 'dist/cli/index.js');
    await writeFile(cli, `import fs from 'node:fs'; import path from 'node:path'; const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('1.6.12');process.exit(0);}
if(a[0]!=='analyze'||!a.includes('--index-only')||!a.includes('--skip-git')||!a.includes('--skip-fts')||process.env.GITNEXUS_EMBEDDING_MODE!=='disabled')process.exit(90);
if(!fs.readFileSync(path.join(a[1],'src/service.ts'),'utf8').includes('return input;'))process.exit(91);
fs.mkdirSync(process.env.GITNEXUS_STORAGE_PATH,{recursive:true});fs.writeFileSync(path.join(process.env.GITNEXUS_STORAGE_PATH,'graph'),'fixture');`);
    await writeFile(join(root, 'dist/mcp/local/local-backend.js'), `import fs from 'node:fs';import path from 'node:path';export class LocalBackend{async executeCypher(repository,query){if(!fs.existsSync(path.join(process.env.GITNEXUS_STORAGE_PATH,'graph')))throw Error('missing index');if(query.includes('node_count'))return[{node_count:1}];return query.startsWith('MATCH (related')?[{changed_path:'src/service.ts',related_path:'test/service.test.ts',start_line:1,end_line:3}]:[];}}`);
    const result = await f.run(['--indexing-provider', 'gitnexus', '--index-executable', cli, '--indexing', 'required']);
    expect(result.code, result.stderr).toBe(0);
    expect((await summary(result.output)).codeContext.provider).toEqual({ id: 'gitnexus', version: '1.6.12' });
    expect((await summary(result.output)).codeContext.relatedSpans).toBe(1);
  });

  it('does not use a mismatched provider version or silently install a replacement', async () => {
    const f = await fixture(); await writeFile(f.provider, (await readFile(f.provider, 'utf8')).replace('CodeGraphContext 0.5.7', 'CodeGraphContext 0.6.5'));
    const result = await f.run(); expect(result.code, result.stderr).toBe(0);
    expect((await summary(result.output)).codeContext.diagnosticCodes).toContain('index-provider-version-unavailable');
    expect((await readFile(f.calls, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('cancels and reaps an active indexer before any review starts', async () => {
    const f = await fixture(); const controller = new AbortController(); const pidFile = join(f.root, 'indexing.pid');
    const text = await readFile(f.provider, 'utf8');
    await writeFile(f.provider, text.replace('const database=process.env.CGC_RUNTIME_DB_PATH;', `if(args[0]==='index'){fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')},String(process.pid));fs.renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)});setInterval(()=>{},1000);await new Promise(()=>{});}const database=process.env.CGC_RUNTIME_DB_PATH;`));
    const watcher = watch(f.root, (_event, filename) => { if (filename === 'indexing.pid') controller.abort(); });
    const timer = setTimeout(() => { controller.abort(); }, 25_000);
    const output = join(f.root, 'cancelled');
    try {
      const code = await main(['review', '--repository', f.repository, '--base', f.base, '--head', 'HEAD', '--harness', 'echo',
        '--index-executable', f.provider, '--output', output], f.env, { cwd: f.root, signal: controller.signal, stdout: () => {}, stderr: () => {} });
      expect(code).toBe(130);
      const pid = Number(await readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await readFile(join(output, 'reviews/summary.json'), 'utf8').catch(() => null)).toBeNull();
      await writeFile(f.provider, text);
      const recovered = await f.run(); expect(recovered.code, recovered.stderr).toBe(0);
      expect(recovered.stderr).toContain('Base index: rebuilt');
    } finally { clearTimeout(timer); watcher.close(); }
  }, 30_000);

  it('makes provider failure explicit and rejects file-only fallback when required', async () => {
    const f = await fixture();
    const bestEffort = await f.run(['--index-executable', join(f.root, 'missing')]);
    expect(bestEffort.code, bestEffort.stderr).toBe(0);
    expect((await summary(bestEffort.output)).codeContext.status).toBe('partial');
    expect((await summary(bestEffort.output)).codeContext.diagnosticCodes).toContain('static-head-context');
    expect(JSON.parse(await readFile(join(bestEffort.output, 'index/status.json'), 'utf8')).status).toBe('unavailable');
    const required = await f.run(['--index-executable', join(f.root, 'missing'), '--indexing', 'required']);
    expect(required.code).toBe(1); expect(required.stderr).toContain('required indexed context');
    expect(await readFile(join(required.output, 'reviews/summary.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('requires context for every reviewed file rather than accepting one successful relationship', async () => {
    const f = await fixture(); await writeFile(join(f.repository, 'README.md'), '# New documentation\n');
    f.git('add', 'README.md'); f.git('commit', '--quiet', '-m', 'docs');
    const result = await f.run(['--indexing', 'required']);
    expect(result.code).toBe(1); expect(result.stderr).toContain('1 required file remains file-only');
    expect(await readFile(join(result.output, 'reviews/summary.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('imports exact-snapshot context without invoking an indexer and rejects stale artifacts', async () => {
    const f = await fixture(); const indexed = await f.run(); expect(indexed.code, indexed.stderr).toBe(0);
    const artifact = join(indexed.output, 'index/code-context.json'); const before = await readFile(f.calls, 'utf8');
    const output = join(f.root, 'imported');
    const args = ['review', '--repository', f.repository, '--base', f.base, '--head', 'HEAD', '--harness', 'echo',
      '--indexing', 'required', '--code-context', artifact, '--output', output];
    const code = await main(args, f.env, { cwd: f.root, stdout: () => {}, stderr: () => {} });
    expect(code).toBe(0); expect((await summary(output)).codeContext.relatedSpans).toBe(1); expect(await readFile(f.calls, 'utf8')).toBe(before);
    const value = JSON.parse(await readFile(artifact, 'utf8')); value.revision = 'f'.repeat(40);
    const stale = join(f.root, 'stale.json'); await writeFile(stale, JSON.stringify(value));
    const staleOutput = join(f.root, 'stale-output');
    const rejected = await main([...args, '--code-context', stale, '--output', staleOutput], f.env, { cwd: f.root, stdout: () => {}, stderr: () => {} });
    expect(rejected).toBe(1); expect(await readFile(join(staleOutput, 'reviews/summary.json'), 'utf8').catch(() => null)).toBeNull();
  });
});

describe('GitHub exporter compatibility entrypoint', () => {
  async function exporter(source?: string) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'redline-export-entrypoint-'))); roots.push(root);
    const wrapper = join(root, 'github/code-index/export.py');
    await mkdir(join(root, 'github/code-index'), { recursive: true });
    await copyFile(new URL('../github/code-index/export.py', import.meta.url), wrapper);
    if (source !== undefined) {
      await mkdir(join(root, 'src/code-index'), { recursive: true });
      await writeFile(join(root, 'src/code-index/export.py'), source);
    }
    const env = { PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      HOME: root, TEMP: root, TMP: root };
    const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']).find((command) =>
      spawnSync(command, ['-I', '-B', '-c', 'import sys; assert sys.version_info >= (3, 12)'], { env, timeout: 5000 }).status === 0);
    if (python === undefined) throw new Error('Python 3.12+ is required for code-index entrypoint tests');
    return (code?: string) => spawnSync(python, code === undefined ? ['-I', '-B', wrapper] : ['-I', '-B', '-c', code, wrapper],
      { env, cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  }

  it('reports a missing shared module with the existing diagnostic prefix and exit code', async () => {
    const run = await exporter(); const result = run();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/^redline code-index: /u);
    expect(result.stderr).not.toContain('Traceback'); expect(result.stdout).toBe('');
  });

  it.each(['ValueError', 'OSError', 'RuntimeError'])('handles %s during shared-module loading and main invocation', async (error) => {
    for (const source of ['raise ' + error + '("controlled fixture failure")\n',
      'def main():\n    raise ' + error + '("controlled fixture failure")\n']) {
      const run = await exporter(source); const result = run();
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toBe('redline code-index: controlled fixture failure' + EOL);
      expect(result.stdout).toBe('');
    }
  });

  it('preserves successful CLI execution and delegated imports used by follow-up queries', async () => {
    const run = await exporter('fixture_value = 7\ndef main():\n    return 0\n');
    const cli = run(); expect(cli.status, cli.stderr).toBe(0);
    const imported = run('import importlib.util, sys\nspec = importlib.util.spec_from_file_location("compat", sys.argv[1])\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nassert module.fixture_value == 7\nassert module.main() == 0\n');
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toBe('');
  });
});
