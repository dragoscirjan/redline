import { execaSync } from 'execa';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const project = fileURLToPath(new URL('../', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('reports a compiler process launch failure without exposing executable paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-build-test-')); roots.push(root);
  const output = join(root, 'dist');
  const script = `process.argv = [process.execPath, ${JSON.stringify(join(project, 'scripts/build.js'))}, ${JSON.stringify(output)}];
    process.execPath = ${JSON.stringify(join(root, 'private-missing-build-runtime'))};
    await import(${JSON.stringify(new URL('../scripts/build.js', import.meta.url).href)});`;
  const result = execaSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, extendEnv: false,
    reject: false, stripFinalNewline: false, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe('redline build: compiler process failed to start (ENOENT)\n');
  expect(result.stderr).not.toContain('private-missing-build-runtime');
  expect(existsSync(output)).toBe(false);
});

it('retains Node diagnostics when the compiler module itself is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-build-module-test-')); roots.push(root);
  await mkdir(join(root, 'scripts')); await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await copyFile(join(project, 'scripts/build.js'), join(root, 'scripts/build.js'));
  await symlink(join(project, 'node_modules/execa'), join(root, 'node_modules/execa'), 'junction');
  const result = execaSync(process.execPath, [join(root, 'scripts/build.js')], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, extendEnv: false,
    reject: false, stripFinalNewline: false, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('MODULE_NOT_FOUND');
  expect(result.stderr).toContain('typescript');
  expect(existsSync(join(root, 'dist'))).toBe(false);
});
