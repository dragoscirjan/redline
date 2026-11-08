import { execaSync } from 'execa';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/local/cli.ts';
import { parseLocalOptions } from '../src/local/options.ts';
import { importLocalContext } from '../src/local/context.ts';
import { loadReviewBundle } from '../src/review/bundle.ts';
import { codeContextForFile, loadReviewCodeContext } from '../src/review/indexed-context.ts';
import { buildFileReviewPrompt } from '../src/review/prompt.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** Make provider execution observable while supplying context as inert data. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'redline-import-context-'))); roots.push(root);
  const repository = join(root, 'repo');
  await mkdir(join(repository, 'src'), { recursive: true }); await mkdir(join(repository, 'test'));
  const env = { PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
    HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  const git = (...args: string[]) => execaSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    extendEnv: false, env: { ...env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stripFinalNewline: false, maxBuffer: 1024 * 1024,
  }).stdout.trim();
  git('init', '--quiet', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'test'); git('config', 'user.email', 'test@localhost');
  await writeFile(join(repository, 'src/service.ts'), 'export function normalize(input: string) { return input; }\n');
  await writeFile(join(repository, 'test/service.test.ts'), "import { normalize } from '../src/service';\n// TEST_CONTRACT_SENTINEL\nexport function testContract() { return normalize('value'); }\n");
  git('add', '.'); git('commit', '--quiet', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'src/service.ts'), 'export function normalize(input: string) { return input.trim(); }\n');
  git('commit', '--quiet', '-am', 'head'); const head = git('rev-parse', 'HEAD');
  const marker = join(root, 'provider-invoked'); const provider = join(root, 'provider.mjs');
  await writeFile(provider, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unexpected'); process.exit(91);`);
  const artifact = { version: 2, repository: 'local/fixture', revision: head, baseRevision: base,
    provider: { id: 'cgc', version: 'fixture' }, status: 'complete',
    files: [{ changedPath: 'src/service.ts', status: 'complete', related: [{ path: 'test/service.test.ts', startLine: 1, endLine: 3, reason: 'recorded test' }] }],
    diagnostics: [], timings: { installationMs: 0, restoreMs: 0, validationMs: 0, indexMs: 0, queryMs: 0, saveMs: null } };
  const path = join(root, 'context.json'); await writeFile(path, JSON.stringify(artifact));
  let counter = 0;
  const run = async (extra: string[] = []) => {
    const output = join(root, `output-${counter++}`); const stdout: string[] = []; const stderr: string[] = [];
    const code = await main(['review', '--repository', repository, '--harness', 'echo', '--base', base, '--head', 'HEAD',
      '--output', output, ...extra], env, { cwd: root, stdout: line => stdout.push(line), stderr: line => stderr.push(line) });
    return { code, output, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  };
  return { root, repository, env, base, head, marker, provider, artifact, path, run };
}
async function summary(output: string) { return JSON.parse(await readFile(join(output, 'reviews/summary.json'), 'utf8')); }
const importArgs = (path: string) => ['--code-context', path, '--code-context-repository', 'local/fixture', '--indexing', 'required'];

describe('prompt-owned indexing and context imports', () => {
  it.each(['cgc', 'gitnexus'])('preserves explicit %s selection without host indexing or provider substitution', async provider => {
    const f = await fixture();
    const options = await parseLocalOptions(['--harness', 'echo', '--indexing', 'enabled', '--indexing-provider', provider], f.env, f.repository);
    expect(options.indexing.provider).toBe(provider); expect(options.indexing.mode).toBe('enabled');
    const result = await f.run(['--indexing-provider', provider, '--index-executable', f.provider]);
    expect(result.code, result.stderr).toBe(0); expect(result.stderr).toContain('echo has no indexing tools');
    await expect(access(f.marker)).rejects.toThrow();
    await expect(access(join(result.output, 'index'))).rejects.toThrow();
    await expect(access(join(f.root, 'state/redline/indexes'))).rejects.toThrow();
  });

  it('rejects required indexing when echo has neither tools nor imported context', async () => {
    const f = await fixture(); const result = await f.run(['--indexing', 'required', '--index-executable', f.provider]);
    expect(result.code).toBe(1); expect(result.stderr).toContain('required indexing needs a native harness');
    await expect(access(join(result.output, 'reviews/summary.json'))).rejects.toThrow();
    await expect(access(f.marker)).rejects.toThrow();
  });

  it('keeps the indexing opt-out and rejects the retired Python runtime option', async () => {
    const f = await fixture(); const disabled = await f.run(['--indexing', 'disabled', '--indexing-provider', 'gitnexus']);
    expect(disabled.code, disabled.stderr).toBe(0); expect(disabled.stderr).not.toContain('Indexing unavailable');
    expect((await summary(disabled.output)).codeContext.provider).toBeNull();
    expect((await f.run(['--index-runtime', process.execPath])).code).toBe(2);
  });

  it('imports matching context and resolves captured related source into the prompt', async () => {
    const f = await fixture(); const result = await f.run(importArgs(f.path)); expect(result.code, result.stderr).toBe(0);
    expect((await summary(result.output)).codeContext.relatedSpans).toBe(1);
    const bundle = await loadReviewBundle(join(result.output, 'bundle'), join(result.output, 'source'));
    const loaded = await loadReviewCodeContext(bundle, { path: join(result.output, 'index/code-context.json'), repository: 'local/fixture' });
    const file = bundle.manifest.files.find(file => file.newPath === 'src/service.ts');
    if (file === undefined) throw new Error('fixture file absent');
    const prompt = await buildFileReviewPrompt({ bundle, file, indexedContext: codeContextForFile(loaded, file).prompt,
      findingScope: 'defects', harness: 'echo', model: 'echo' });
    expect(prompt.user).toContain('TEST_CONTRACT_SENTINEL');
    await expect(access(f.marker)).rejects.toThrow();
    const status = JSON.parse(await readFile(join(result.output, 'index/status.json'), 'utf8'));
    expect(status.indexCache).toBe('imported');
  });

  it.each(['revision', 'baseRevision', 'repository'])('rejects an import with mismatched %s before required review', async field => {
    const f = await fixture(); await writeFile(f.path, JSON.stringify({ ...f.artifact, [field]: field === 'repository' ? 'another/repository' : 'f'.repeat(40) }));
    const result = await f.run(importArgs(f.path)); expect(result.code).toBe(1);
    expect(result.stderr).toContain('required indexed context');
    await expect(access(join(result.output, 'reviews/summary.json'))).rejects.toThrow();
  });

  it.each(['malformed', 'oversized', 'missing'])('fails closed on a %s artifact', async kind => {
    const f = await fixture();
    if (kind === 'malformed') await writeFile(f.path, '{');
    else if (kind === 'oversized') await writeFile(f.path, ' '.repeat(128 * 1024 + 1));
    else await rm(f.path);
    const result = await f.run(importArgs(f.path)); expect(result.code).toBe(1);
    expect(result.stderr).toContain('required indexed context');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked artifact', async () => {
    const f = await fixture(); const target = join(f.root, 'target.json');
    await writeFile(target, JSON.stringify(f.artifact)); await rm(f.path); await symlink(target, f.path);
    const result = await f.run(importArgs(f.path)); expect(result.code).toBe(1);
  });

  it('rejects required imports that leave another reviewed file without related source', async () => {
    const f = await fixture(); await writeFile(join(f.repository, 'README.md'), 'Another reviewed file\n');
    // Include documentation in a committed head, then bind the import to that exact head.
    const git = (...args: string[]) => execaSync('git', ['-C', f.repository, '-c', 'core.hooksPath=/dev/null', ...args], {
      extendEnv: false, env: { ...f.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stripFinalNewline: false, maxBuffer: 1024 * 1024,
    }).stdout.trim();
    git('add', 'README.md'); git('commit', '--quiet', '-m', 'docs');
    await writeFile(f.path, JSON.stringify({ ...f.artifact, revision: git('rev-parse', 'HEAD') }));
    const required = await f.run(importArgs(f.path)); expect(required.code).toBe(1);
    expect(required.stderr).toContain('required indexed context');
  });

  it('redacts selected credentials in imported diagnostic codes and messages before saving', async () => {
    const f = await fixture(); const baseline = await f.run(['--indexing', 'disabled']); expect(baseline.code).toBe(0);
    const secret = 'secret-fixture';
    await writeFile(f.path, JSON.stringify({ ...f.artifact, diagnostics: [{ level: 'warning', code: secret, message: `provider diagnostic ${secret}` }] }));
    const options = await parseLocalOptions(['--harness', 'echo', '--code-context', f.path, '--code-context-repository', 'local/fixture'], f.env, f.repository);
    const output = join(f.root, 'redacted');
    const imported = await importLocalContext({ reviewDirectory: join(baseline.output, 'bundle'), sourceDirectory: join(baseline.output, 'source'), dispose: async () => {} },
      { ...options, environment: { ...options.environment, credential: { provider: 'mock', value: secret } } }, output, new AbortController().signal);
    expect(imported.coverage.relatedSpans).toBe(1);
    const persisted = await readFile(join(output, 'index/code-context.json'), 'utf8');
    expect(persisted).not.toContain(secret); expect(persisted).toContain('credential-redacted'); expect(persisted).toContain('[redacted]');
    expect(await readFile(join(output, 'index/status.json'), 'utf8')).not.toContain(secret);
  });

  it('never trusts an unavailable artifact as required readiness', async () => {
    const f = await fixture();
    await writeFile(f.path, JSON.stringify({ ...f.artifact, status: 'unavailable', files: [] }));
    const result = await f.run(importArgs(f.path)); expect(result.code).toBe(1);
    expect(result.stderr).toContain('required indexed context');
  });
});
