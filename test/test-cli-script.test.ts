import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../test-cli.sh', import.meta.url));
describe.skipIf(process.platform === 'win32')('test-cli tee contract', () => {
  for (const status of [0, 7]) {
    it('logs stdout/stderr and preserves review exit ' + status, async () => {
      const root = await mkdtemp(join(tmpdir(), 'redline-tee-test-'));
      try {
        const repo = join(root, 'repo'), home = join(root, 'home'), logs = join(root, 'logs');
        await Promise.all([repo, home].map(path => mkdir(path)));
        const git = (...args: string[]) => execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo,
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
        await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
        await git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture');
        const node = join(root, 'synthetic-node');
        await writeFile(node, '#!/bin/sh\nif [ "$1" = --input-type=module ]; then printf "%s" "$REDLINE_MODEL_AUTH"; exit 0; fi\nprintf "review stdout\\n"\nprintf "review stderr\\n" >&2\nexit "$TEST_REVIEW_EXIT"\n', { mode: 0o700 });
        const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home,
          REDLINE_MODEL_AUTH: '{"openrouter":"synthetic-tee-private-key"}', TEST_NODE: node,
          TEST_LOG_DIR: logs, TEST_OUTPUT_DIR: join(root, 'output'), TEST_REVIEW_EXIT: String(status) };
        let code = 0, stdout = '', stderr = '';
        try { const result = await execute('bash', [script, 'pi'], { cwd: repo, env }); stdout = result.stdout; stderr = result.stderr; }
        catch (error) {
          const failure = error as Error & { code: number; stdout: string; stderr: string };
          code = failure.code; stdout = failure.stdout; stderr = failure.stderr;
        }
        expect(code).toBe(status);
        expect(stdout).toContain('review stdout\nreview stderr\n');
        expect(stderr).toBe('');
        const names = await readdir(logs);
        expect(names).toHaveLength(1);
        expect(await readFile(join(logs, names[0]!), 'utf8')).toBe(stdout);
        expect(stdout).not.toContain('synthetic-tee-private-key');
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});
