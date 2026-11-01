import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record } from '../harness-worker/contract.ts';
import { frame, FrameReader } from '../transport/framing.ts';
const exec = promisify(execFile);
/** Test exact packed bytes before publication. No registry, install lifecycle, host config or live models. */
export async function verifyOfflineCandidate(tarball: string, version: string): Promise<{ readonly checks: readonly string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'redline-candidate-smoke-'));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    NPM_CONFIG_USERCONFIG: join(root, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(root, 'global-npmrc'), NPM_CONFIG_CACHE: join(root, 'cache'),
    NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_OFFLINE: 'true', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  try {
    await writeFile(join(root, 'npmrc'), 'registry=https://registry.npmjs.org/\n', { mode: 0o600 }); await writeFile(join(root, 'global-npmrc'), '', { mode: 0o600 });
    const info = await exec('tar', ['-xOf', tarball, 'package/package.json'], { env, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 30_000 });
    const metadata: unknown = JSON.parse(info.stdout);
    if (!record(metadata) || metadata.name !== '@dragoscirjan/redline' || metadata.version !== version
      || ['dependencies', 'peerDependencies', 'optionalDependencies'].some(name => metadata[name] !== undefined && (!record(metadata[name]) || Object.keys(metadata[name]).length !== 0))) throw new Error('Candidate has unexpected runtime dependencies or identity');
    const scripts = record(metadata.scripts) ? metadata.scripts : {};
    if (['preinstall', 'install', 'postinstall'].some(name => Object.hasOwn(scripts, name))) throw new Error('Candidate has an install lifecycle');
    const installation = join(root, 'installation'); await mkdir(installation);
    await exec('npm', ['install', '--prefix', installation, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', tarball],
      { cwd: root, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const binary = join(installation, 'node_modules/@dragoscirjan/redline/bin/redline.mjs');
    const run = (args: string[], cwd = root) => exec(process.execPath, [binary, ...args], { cwd, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    if ((await run(['--version'])).stdout.trim() !== 'redline ' + version || !(await run(['--help'])).stdout.includes('--worktree')) throw new Error('Installed candidate CLI identity failed');
    const repository = join(root, 'repository'); await mkdir(repository);
    const git = async (...args: string[]) => (await exec('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...args], { env, maxBuffer: 1024 * 1024, timeout: 30_000 })).stdout.trim();
    await git('init', '--quiet', '-b', 'main'); await git('config', 'user.name', 'Candidate verification'); await git('config', 'user.email', 'candidate@example.invalid');
    await writeFile(join(repository, 'example.ts'), 'old\n'); await git('add', '.'); await git('commit', '--quiet', '-m', 'base'); const base = await git('rev-parse', 'HEAD');
    await writeFile(join(repository, 'example.ts'), 'new\n'); await git('commit', '--quiet', '-am', 'head');
    for (const args of [['--base', base, '--head', 'HEAD'], []]) {
      if (args.length === 0) await writeFile(join(repository, 'example.ts'), 'working\n');
      const result = await run(['review', '--harness', 'echo', '--indexing', 'disabled', '--reuse', 'disabled', ...args], repository);
      if (!result.stdout.includes('Artifacts:')) throw new Error('Installed candidate review did not produce artifacts');
    }
    const rpc = exec(process.execPath, [binary, 'rpc', '--once', '--harness', 'echo', '--indexing', 'disabled'], { cwd: root, env, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'buffer' });
    const reader = new FrameReader(); let initialized = false;
    rpc.child.stdout?.on('data', (part: Buffer) => {
      try {
        for (const body of reader.push(part)) {
          const value: unknown = JSON.parse(body.toString('utf8'));
          if (!initialized && record(value) && value.id === 1 && record(value.result) && value.result.protocolVersion === '1.0') {
            initialized = true; rpc.child.stdin?.write(frame({ jsonrpc: '2.0', id: 2, method: 'redline/v1/shutdown', params: {} }));
          }
          if (record(value) && value.id === 2) rpc.child.stdin?.end();
          if (record(value) && (value.id === 1 || value.id === 2) && value.error !== undefined) rpc.child.kill('SIGKILL');
        }
      } catch { rpc.child.kill('SIGKILL'); }
    });
    rpc.child.stdin?.write(frame({ jsonrpc: '2.0', id: 1, method: 'redline/v1/initialize', params: { protocolVersion: '1.0' } }));
    await rpc; reader.end();
    if (!initialized) throw new Error('Installed candidate RPC handshake failed');
    const installed: unknown = JSON.parse(await readFile(join(installation, 'node_modules/@dragoscirjan/redline/package.json'), 'utf8'));
    if (!record(installed) || installed.version !== version) throw new Error('Installed candidate package version mismatch');
    return { checks: ['offline-install-without-scripts', 'cli-help-and-version', 'committed-review-echo', 'worktree-review-echo', 'rpc-initialize-once'] };
  } finally { await rm(root, { recursive: true, force: true }); }
}
