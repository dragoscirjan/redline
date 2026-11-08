import { execa } from 'execa';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../..', import.meta.url));

/** Stage and compile trusted tool code outside the checkout; the caller owns the returned cleanup operation. */
export async function prepareCompiledTool(): Promise<{ readonly root: string; readonly driver: string; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'redline-compiled-tool-'));
  try {
    for (const name of ['package.json', 'test-cli.sh', 'bin', 'src', 'prompts', 'schemas']) {
      await cp(join(project, name), join(root, name), { recursive: true });
    }
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'junction');
    await execa(process.execPath, [join(project, 'scripts/build.js'), join(root, 'dist')], {
      cwd: project,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, TEMP: root, TMP: root, TMPDIR: root },
      extendEnv: false, preferLocal: false, shell: false, verbose: 'none', timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    return { root, driver: join(root, 'test-cli.sh'), close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
