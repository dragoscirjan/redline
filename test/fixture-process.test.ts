import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeFixtureContainers, runFixtureProcess } from './helpers/fixture-process.ts';

describe.skipIf(process.platform === 'win32')('native fixture resource ownership', () => {
  it('terminates a timed-out fixture and its detached sleeping descendant before returning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-fixture-tree-'));
    let descendant: number | undefined;
    try {
      const execa = pathToFileURL(createRequire(import.meta.url).resolve('execa')).href;
      const program = `import(${JSON.stringify(execa)}).then(({execa}) => {
        const child = execa(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
          {detached: true, stdio: 'ignore', reject: false});
        console.log(child.pid); setInterval(() => {}, 1000);
      });`;
      const result = await runFixtureProcess(process.execPath, ['-e', program], {
        cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 1000,
      });
      const pid = Number(result.stdout.trim());
      descendant = pid;
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(result.timedOut).toBe(true);
      await expect.poll(async () => {
        try {
          process.kill(pid, 0);
          // A killed orphan can briefly remain as a non-running zombie until init reaps it.
          const stat = await readFile('/proc/' + descendant + '/stat', 'utf8').catch(() => '');
          return /\) Z /u.test(stat);
        } catch { return true; }
      }, { timeout: 3000 }).toBe(true);
    } finally {
      if (descendant !== undefined && Number.isSafeInteger(descendant) && descendant > 0) {
        try { process.kill(descendant, 'SIGKILL'); } catch { /* Already exited. */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('removes only recorded fixture container IDs using argument arrays', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-fixture-cid-'));
    try {
      const calls = join(root, 'calls.json');
      await writeFile(join(root, 'docker'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
      const prefix = join(root, 'container id');
      const id = 'a'.repeat(64);
      await writeFile(prefix + '-pi', id + '\n');
      await removeFixtureContainers(prefix, { PATH: root });
      expect(JSON.parse(await readFile(calls, 'utf8'))).toEqual(['rm', '--force', id]);
      await writeFile(prefix + '-opencode', '--invalid');
      await expect(removeFixtureContainers(prefix, { PATH: root })).rejects.toThrow('Invalid fixture container ID');
      await expect(access(prefix + '-opencode')).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
