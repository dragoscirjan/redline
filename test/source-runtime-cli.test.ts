import { execaSync } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../src/benchmark/source-runtime-cli.ts', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'redline-source-runtime-test-')); roots.push(root);
  const bin = join(root, 'bin'); await mkdir(bin);
  const json = join(root, 'report.json'); const markdown = join(root, 'report.md');
  const run = () => execaSync(process.execPath, [cli, '--runtime', 'bun', '--json', json, '--markdown', markdown], {
    cwd: root, env: { PATH: bin, SystemRoot: process.env.SystemRoot, HOME: root, TEMP: root, TMP: root },
    extendEnv: false, reject: false, stripFinalNewline: false, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  return { bin, json, markdown, run };
}

it('identifies a missing benchmark executable without exposing Execa command details', async () => {
  const f = await fixture(); const result = f.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe('source runtime benchmark: bun exited without status: process launch failed (ENOENT)\n');
  expect(result.stderr).not.toContain('--version');
  expect(result.stderr).not.toContain(f.bin);
  expect(existsSync(f.json)).toBe(false); expect(existsSync(f.markdown)).toBe(false);
});

it.skipIf(process.platform === 'win32')('identifies executable permission failures without dumping the command', async () => {
  const f = await fixture();
  await writeFile(join(f.bin, 'bun'), '#!'+process.execPath+'\nprocess.exit(0);\n', { mode: 0o600 });
  const result = f.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe('source runtime benchmark: bun exited without status: process launch failed (EACCES)\n');
  expect(result.stderr).not.toContain(f.bin);
});

it.skipIf(process.platform === 'win32')('reports output overflow without echoing captured payloads', async () => {
  const f = await fixture();
  await writeFile(join(f.bin, 'bun'), '#!'+process.execPath+'\nprocess.stdout.write("private-output".repeat(10000));\n', { mode: 0o700 });
  const result = f.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('process output exceeded its byte limit');
  expect(result.stderr).not.toContain('private-output');
});

it.skipIf(process.platform === 'win32')('preserves bounded stderr and exit status for an executed benchmark command', async () => {
  const f = await fixture();
  await writeFile(join(f.bin, 'bun'), '#!'+process.execPath+'\nprocess.stderr.write("synthetic benchmark failure"); process.exit(7);\n', { mode: 0o700 });
  const result = f.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe('source runtime benchmark: bun exited 7: synthetic benchmark failure\n');
});
