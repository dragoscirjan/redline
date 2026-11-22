import { execaSync } from 'execa';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const project = fileURLToPath(new URL('../', import.meta.url));
interface PackedPackage {
  readonly name: string;
  readonly filename: string;
  readonly files: readonly { readonly path: string }[];
}

// Adapted from the archived npm helper; invoke npm without a platform shell shim.
function npmArguments(args: readonly string[]): string[] {
  const directory = dirname(process.execPath);
  const candidates = [
    join(directory, 'node_modules/npm/bin/npm-cli.js'),
    resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  if (process.platform !== 'win32') {
    for (const path of (process.env.PATH ?? '').split(delimiter)) {
      const executable = join(path, 'npm');
      if (existsSync(executable)) candidates.push(realpathSync(executable));
    }
  }
  const cli = candidates.find(path => existsSync(path) && path.endsWith('npm-cli.js'));
  if (cli === undefined) throw new Error('Node must include npm for installed-package checks');
  return [cli, ...args];
}

interface PackageMetadata {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

// Adapt the archived offline fixture rather than fetch dependencies during tests.
function productionDirectories(): readonly string[] {
  const manifest: PackageMetadata = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  const pending = Object.keys(manifest.dependencies ?? {}).map(name => ({ name, from: project }));
  const directories = new Set<string>();
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (dependency === undefined) break;
    const search = createRequire(join(dependency.from, 'package.json')).resolve.paths(dependency.name) ?? [];
    const location = search.map(path => join(path, dependency.name)).find(path => existsSync(join(path, 'package.json')));
    if (location === undefined) throw new Error('Cannot locate production dependency metadata');
    const directory = realpathSync(location);
    if (directories.has(directory)) continue;
    directories.add(directory);
    const metadata: PackageMetadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    for (const name of Object.keys(metadata.dependencies ?? {})) pending.push({ name, from: directory });
  }
  return [...directories];
}

describe('package distribution', () => {
  let root: string;
  let staged: string;
  let env: NodeJS.ProcessEnv;
  let archive: PackedPackage;
  let installed: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'redline-package-'));
    staged = join(root, 'package');
    await mkdir(staged);
    env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root,
      TEMP: root, TMP: root, TMPDIR: root,
      npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'absent-npmrc'),
      npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    };
    for (const name of ['package.json', 'README.md', 'LICENSE', 'bin', 'src']) {
      await cp(join(project, name), join(staged, name), { recursive: true });
    }
    // Exercise the actual package allowlist with historical content present.
    for (const path of ['src.pre-v4', 'archive/pre-v4', 'test', '.agents']) {
      await mkdir(join(staged, path), { recursive: true });
      await writeFile(join(staged, path, 'must-not-ship.txt'), 'historical or development content\n');
    }
    execaSync(process.execPath, [join(project, 'scripts/build.js'), join(staged, 'dist')], {
      cwd: project, env, extendEnv: false, maxBuffer: 1024 * 1024,
    });
    const packed: readonly PackedPackage[] = JSON.parse(execaSync(process.execPath,
      npmArguments(['pack', staged, ...productionDirectories(), '--ignore-scripts', '--json', '--pack-destination', root]), {
        cwd: root, env, extendEnv: false, maxBuffer: 8 * 1024 * 1024,
      }).stdout);
    const candidate = packed.find(entry => entry.name === '@dragoscirjan/redline');
    if (candidate === undefined) throw new Error('Redline package archive is missing');
    archive = candidate;
    installed = join(root, 'installed');
    await mkdir(installed);
    execaSync(process.execPath, npmArguments([
      'install', '--prefix', installed, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--package-lock=false', ...packed.map(entry => join(root, entry.filename)),
    ]), { cwd: installed, env, extendEnv: false, maxBuffer: 1024 * 1024 });
  }, 60_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('ships the compiled Effect boundary without requiring a checkout build', () => {
    expect(archive.files.map(entry => entry.path)).toContain('dist/application/review.js');
  });

  it('ships Git capture and its source dependencies for both runtime paths', () => {
    expect(archive.files.map(entry => entry.path)).toEqual(expect.arrayContaining([
      'dist/revision-source/git.js', 'dist/context-bundle.js', 'dist/review-eligibility.js',
      'src/revision-source/git.ts', 'src/revision-source/process.ts', 'src/revision-source/types.ts',
      'src/context-bundle.ts', 'src/review-eligibility.ts',
    ]));
  });

  it('excludes historical and development content even when present during packing', () => {
    expect(archive.files.filter(entry => /^(?:src\.pre-v4|archive|test|node_modules|\.agents)\//u.test(entry.path))).toEqual([]);
  });

  it.each(['node', 'bun'])('reports honest installed-package status using %s', runtime => {
    const entry = join(installed, 'node_modules/@dragoscirjan/redline/bin/redline.mjs');
    const result = execaSync(process.execPath, [entry, 'status', '--json'], {
      cwd: installed, env: { ...env, REDLINE_ENV: runtime }, extendEnv: false, maxBuffer: 1024 * 1024,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      phase: 'scaffold', review: 'not-implemented', modelRuntime: 'not-implemented',
      mcp: 'not-implemented', publication: 'not-implemented', docker: 'scaffold-only',
    });
  });

  it.each(['node', 'bun'])('loads the installed review prototype with %s and rejects its unimplemented body', runtime => {
    const source = runtime === 'node' ? 'dist/application/review.js' : 'src/application/review.ts';
    const script = `
      import { Effect } from 'effect';
      import { ReviewApplication } from ${JSON.stringify('./node_modules/@dragoscirjan/redline/' + source)};
      const error = await Effect.runPromise(Effect.gen(function* () {
        const application = yield* ReviewApplication;
        return yield* application.review({
          repository: '/unused/repository', base: 'base',
          target: { kind: 'revision', head: 'head', comparison: 'direct' },
        });
      }).pipe(Effect.provide(ReviewApplication.layer), Effect.flip));
      console.log(error.message);
    `;
    const result = execaSync(runtime, ['--input-type=module', '-e', script], {
      cwd: installed, env, extendEnv: false, maxBuffer: 1024 * 1024,
    });
    expect(result.stdout).toContain('Not implemented');
  });

  it.each(['node', 'bun'])('captures a real Git change using the offline-installed %s module', async runtime => {
    const repository = join(root, 'repository-' + runtime);
    await mkdir(repository);
    const gitEnv = {
      ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost',
    };
    const git = (...args: string[]): string => execaSync('git', [
      '-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args,
    ], { env: gitEnv, extendEnv: false, maxBuffer: 1024 * 1024 }).stdout;
    git('init', '--quiet', '--template=');
    await writeFile(join(repository, 'example.ts'), 'before\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(repository, 'example.ts'), 'after\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'head');
    const head = git('rev-parse', 'HEAD');
    const source = runtime === 'node' ? 'dist/revision-source/git.js' : 'src/revision-source/git.ts';
    const request = { repository, base, target: { kind: 'revision', head, comparison: 'direct' }, outputDirectory: join(root, 'capture-' + runtime) };
    const script = `
      import { readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { GitRevisionSource } from ${JSON.stringify('./node_modules/@dragoscirjan/redline/' + source)};
      const captured = await new GitRevisionSource(${JSON.stringify(request)}, process.env).capture(new AbortController().signal);
      try {
        const manifest = JSON.parse(await readFile(join(captured.reviewDirectory, 'manifest.json'), 'utf8'));
        const source = await readFile(join(captured.sourceDirectory, 'example.ts'), 'utf8');
        console.log(JSON.stringify({ source, base: manifest.base, head: manifest.head }));
      } finally { await captured.dispose(); }
    `;
    const result = execaSync(runtime, ['--input-type=module', '-e', script], {
      cwd: installed, env, extendEnv: false, maxBuffer: 1024 * 1024,
    });
    expect(JSON.parse(result.stdout)).toEqual({ source: 'after\n', base, head });
  });

  it.each([
    ['node', 'redline.mjs', 'review'], ['node', 'redline.mjs', 'rpc'], ['node', 'redline-review.mjs'],
    ['bun', 'redline.mjs', 'review'], ['bun', 'redline.mjs', 'rpc'], ['bun', 'redline-review.mjs'],
  ])('rejects installed %s %s %s without a review result', (runtime, entry, command?: string) => {
    const binary = join(installed, 'node_modules/@dragoscirjan/redline/bin', entry);
    const result = execaSync(process.execPath, [binary, ...(command === undefined ? [] : [command])], {
      cwd: installed, env: { ...env, REDLINE_ENV: runtime }, extendEnv: false,
      reject: false, maxBuffer: 1024 * 1024,
    });
    expect({ exitCode: result.exitCode, stdout: result.stdout, unavailable: result.stderr.includes('execution is not implemented') })
      .toEqual({ exitCode: 2, stdout: '', unavailable: true });
  });
});
