/** Build the Node distribution without changing source imports or installing tools. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 3) throw new Error('Usage: node scripts/build.js [output-directory]');
const output = resolve(root, process.argv[2] ?? 'dist');
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const result = spawnSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.build.json'), '--outDir', output], {
  cwd: root, stdio: 'inherit',
});
if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  // These helpers are resolved relative to compiled code-index modules.
  for (const name of ['lock.py', 'export.py', 'gitnexus-query.mjs']) {
    const target = join(output, 'code-index', name);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, 'src/code-index', name), target);
  }
}
