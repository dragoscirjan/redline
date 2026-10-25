import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.ts';
import { npmArguments } from './helpers/npm.ts';

const project = fileURLToPath(new URL('../', import.meta.url));

it('installs the packed package offline and runs both CLIs without source checkout dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-package-test-'));
  const fixture = await createBundleFixture();
  try {
    const env = { PATH: process.env.PATH, HOME: root, SystemRoot: process.env.SystemRoot,
      TEMP: root, TMP: root, TMPDIR: root, npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'absent-npmrc'),
      npm_config_registry: 'https://registry.npmjs.org', npm_config_offline: 'true',
      XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    };
    const packed: { filename: string; files: { path: string }[] }[] = JSON.parse(execFileSync(process.execPath,
      npmArguments(['pack', '--ignore-scripts', '--json', '--pack-destination', root]), { cwd: project, env, encoding: 'utf8' }));
    const archive = packed[0]!;
    const paths = archive.files.map((entry) => entry.path);
    expect(paths).toContain('prompts/v7/core-policy.md');
    expect(paths).toContain('bin/redline.mjs');
    expect(paths.some((path) => /^(?:test|benchmark|src\.old|node_modules|\.agents|\.github|dist)\//u.test(path))).toBe(false);
    const installation = join(root, 'installation'); await mkdir(installation);
    execFileSync(process.execPath, npmArguments(['install', '--prefix', installation, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', join(root, archive.filename)]), { env, encoding: 'utf8' });
    const binary = join(installation, 'node_modules/@dragoscirjan/redline/bin/redline.mjs');
    const legacy = join(dirname(binary), 'redline-review.mjs');
    const run = (args: string[], cwd = root) => spawnSync(process.execPath, [binary, ...args], { env, cwd, encoding: 'utf8' });
    const help = run(['--help']); expect(help.status, help.stderr).toBe(0); expect(help.stdout).toContain('--worktree');
    const version = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version;
    expect(run(['--version']).stdout.trim()).toBe(`redline ${version}`);
    expect(run(['review', '--vcs', 'jj']).status).toBe(4);
    const repository = join(root, 'repo'); await mkdir(repository);
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
    git('init', '--quiet', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@localhost');
    await writeFile(join(repository, 'example.ts'), 'old\n'); git('add', '.'); git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(repository, 'example.ts'), 'new\n'); git('commit', '--quiet', '-am', 'head');
    const revisions = run(['review', '--harness', 'echo', '--base', base, '--head', 'HEAD'], repository);
    expect(revisions.status, revisions.stderr).toBe(0); expect(revisions.stdout).toContain('Artifacts:');
    await writeFile(join(repository, 'example.ts'), 'working\n');
    const working = run(['review', '--harness', 'echo'], repository);
    expect(working.status, working.stderr).toBe(0);
    const old = spawnSync(process.execPath, [legacy], { env: { ...env, ...cleanReviewEnvironment(fixture, 'echo') }, cwd: root, encoding: 'utf8' });
    expect(old.status, old.stderr).toBe(0); expect(JSON.parse(old.stdout).harness).toBe('echo');
    const installed = JSON.parse(await readFile(join(installation, 'node_modules/@dragoscirjan/redline/package.json'), 'utf8'));
    expect(installed.dependencies).toBeUndefined();
    expect(installed.scripts.install).toBeUndefined(); expect(installed.scripts.postinstall).toBeUndefined();
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
