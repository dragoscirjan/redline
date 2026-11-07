import { execa, execaSync } from 'execa';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const project = fileURLToPath(new URL('../', import.meta.url));
const roots: string[] = [];
const bunAvailable = execaSync('bun', ['--version'], {
  stripFinalNewline: false,
  reject: false,
  stdio: 'ignore',
  maxBuffer: 1024 * 1024,
}).exitCode === 0;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  // macOS temporary paths can use /var, while process.cwd() reports /private/var.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'redline runtime '))); roots.push(root);
  const cwd = join(root, 'caller directory'); await mkdir(cwd);
  await cp(join(project, 'bin'), join(root, 'bin'), { recursive: true });
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'junction');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const mode of ['src', 'dist']) {
    for (const entry of ['local/cli', 'review/cli', 'rpc/main']) {
      await mkdir(join(root, mode, entry.split('/')[0] ?? ''), { recursive: true });
      const compiled = mode === 'dist';
      await writeFile(join(root, mode, entry + (compiled ? '.js' : '.ts')), `
const compiled${compiled ? '' : ': boolean'} = ${compiled};
export async function main(args = process.argv.slice(${entry === 'rpc/main' ? 3 : 2}), env = process.env) {
  console.log(JSON.stringify({ args, cwd: process.cwd(), entry: ${JSON.stringify(entry)},
    runtime: process.versions.bun ? 'bun' : 'node', mode: compiled ? 'compiled' : 'typescript', selector: env.REDLINE_ENV ?? null }));
  if (env.FIXTURE_WAIT === '1') {
    const timer = setInterval(() => {}, 1000);
    await new Promise(resolve => process.once('SIGTERM', () => { clearInterval(timer); resolve(); }));
    return 143;
  }
  return Number(env.FIXTURE_EXIT ?? 0);
}
`);
    }
  }
  return { root, cwd };
}

for (const bootstrap of ['node', 'bun']) {
  describe.skipIf(bootstrap === 'bun' && !bunAvailable)(`${bootstrap} JavaScript bootstrap`, () => {
    const command = bootstrap === 'node' ? process.execPath : 'bun';
    for (const runtime of ['node', 'bun']) {
      it.skipIf(runtime === 'bun' && !bunAvailable).each(['redline', 'redline-review'])(`runs %s with ${runtime} and preserves arguments, cwd, and exit status`, async name => {
        const f = await fixture(); const args = ['space value', '', '--flag=value', 'literal!value'];
        const result = execaSync(command, [join(f.root, 'bin', name + '.mjs'), ...args], {
          extendEnv: false,
          stripFinalNewline: false,
          reject: false,
          cwd: f.cwd,
          encoding: 'utf8',
          timeout: 10_000,
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, REDLINE_ENV: runtime, FIXTURE_EXIT: '37' },
          maxBuffer: 1024 * 1024,
        });
        expect(result.exitCode, result.stderr).toBe(37);
        expect(JSON.parse(result.stdout)).toMatchObject({ args, cwd: f.cwd, runtime,
          mode: runtime === 'node' ? 'compiled' : 'typescript', selector: null,
          entry: name === 'redline' ? 'local/cli' : 'review/cli' });
      });
    }

    it.each([undefined, ''])('defaults selector %j to compiled Node, regardless of the bootstrap runtime', async selector => {
      const f = await fixture();
      const result = execaSync(command, [join(f.root, 'bin/redline.mjs'), 'rpc', '--help'], {
        extendEnv: false,
        stripFinalNewline: false,
        reject: false,
        cwd: f.cwd,
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...(selector === undefined ? {} : { REDLINE_ENV: selector }) },
        maxBuffer: 1024 * 1024,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ entry: 'rpc/main', args: ['--help'], runtime: 'node', mode: 'compiled' });
    });

    it('reports delegation dependency load failures without exposing module errors', async () => {
      const f = await fixture();
      await rm(join(f.root, 'node_modules'), { recursive: true, force: true });
      const dependency = join(f.root, 'node_modules/execa'); await mkdir(dependency, { recursive: true });
      await writeFile(join(dependency, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
      await writeFile(join(dependency, 'index.js'), 'throw new Error("private-dependency-load-detail");');
      const result = execaSync(command, [join(f.root, 'bin/redline.mjs')], {
        cwd: f.cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          REDLINE_ENV: bootstrap === 'node' ? 'bun' : 'node' },
        extendEnv: false, reject: false, stripFinalNewline: false, timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('redline: runtime delegation dependency is unavailable; reinstall Redline\n');
      expect(result.stderr).not.toContain('private-dependency-load-detail');
    });

    it('rejects an unknown selector without printing or executing its contents', async () => {
      const f = await fixture();
      const result = execaSync(command, [join(f.root, 'bin/redline.mjs')], {
        extendEnv: false,
        stripFinalNewline: false,
        reject: false,
        cwd: f.cwd,
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, REDLINE_ENV: 'private-value; echo injected' },
        maxBuffer: 1024 * 1024,
      });
      expect(result.exitCode).toBe(2); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('REDLINE_ENV must be node or bun');
      expect(result.stderr).not.toContain('private-value');
    });
  });
}

it('reports a missing selected runtime without falling back', async () => {
  const f = await fixture();
  const result = execaSync(process.execPath, [join(f.root, 'bin/redline.mjs')], {
    extendEnv: false,
    stripFinalNewline: false,
    reject: false,
    cwd: f.cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: join(f.root, 'no-runtimes'), SystemRoot: process.env.SystemRoot, REDLINE_ENV: 'bun' },
    maxBuffer: 1024 * 1024,
  });
  expect(result.exitCode).toBe(2); expect(result.stdout).toBe('');
  expect(result.stderr).toContain('selected runtime bun is unavailable');
});

it('requires a Node build instead of silently loading source TypeScript', async () => {
  const f = await fixture(); await rm(join(f.root, 'dist'), { recursive: true });
  const result = execaSync(process.execPath, [join(f.root, 'bin/redline.mjs'), '--help'], {
    extendEnv: false,
    stripFinalNewline: false,
    reject: false,
    cwd: f.cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    maxBuffer: 1024 * 1024,
  });
  expect(result.exitCode).toBe(2); expect(result.stdout).toBe('');
  expect(result.stderr).toContain('compiled entrypoint is missing; run pnpm run build');
});

it.skipIf(!bunAvailable)('runs Bun TypeScript without requiring a Node build', async () => {
  const f = await fixture(); await rm(join(f.root, 'dist'), { recursive: true });
  const result = execaSync('bun', [join(f.root, 'bin/redline.mjs'), '--help'], {
    extendEnv: false,
    stripFinalNewline: false,
    reject: false,
    cwd: f.cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, REDLINE_ENV: 'bun' },
    maxBuffer: 1024 * 1024,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ runtime: 'bun', mode: 'typescript', selector: null });
});

it.skipIf(!bunAvailable || process.platform === 'win32')('forwards termination through the npm Node-to-Bun bootstrap', async () => {
  const f = await fixture();
  const child = execa(process.execPath, [join(f.root, 'bin/redline.mjs')], {
    extendEnv: false,
    reject: false,
    buffer: false,
    cwd: f.cwd,
    env: { PATH: process.env.PATH, REDLINE_ENV: 'bun', FIXTURE_WAIT: '1' },
    stdio: 'pipe',
  }).nodeChildProcess;
  const stdout = child.stdout;
  if (stdout === null) throw new Error('Runtime fixture requires piped stdout');
  const exit = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await new Promise<void>((resolve, reject) => {
      stdout.once('data', () => resolve()); child.once('error', reject);
      child.once('close', () => reject(new Error('Runtime exited before readiness')));
    });
    child.kill('SIGTERM');
    expect(await exit).toBe(143);
  } finally { clearTimeout(watchdog); child.kill('SIGKILL'); }
});
