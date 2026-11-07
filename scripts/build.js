/** Build the Node distribution without changing source imports or installing tools. */
import { execaSync } from 'execa';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 3) throw new Error('Usage: node scripts/build.js [output-directory]');
const output = resolve(root, process.argv[2] ?? 'dist');
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const result = execaSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.build.json'), '--outDir', output], {
  cwd: root, stdio: 'inherit', reject: false, preferLocal: false, shell: false, verbose: 'none',
});
if (result.failed) {
  if (result.exitCode === undefined) {
    const code = ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].find(value => value === result.code);
    const reason = result.signal === undefined ? 'failed to start' : 'terminated before completion';
    process.stderr.write(`redline build: compiler process ${reason}${code === undefined ? '' : ` (${code})`}\n`);
  }
  process.exitCode = result.exitCode ?? 1;
} else {
  // These helpers are resolved relative to compiled code-index modules.
  for (const name of ['lock.py', 'export.py', 'gitnexus-query.mjs']) {
    const target = join(output, 'code-index', name);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, 'src/code-index', name), target);
  }
}
