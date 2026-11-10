import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../test-cli.sh', import.meta.url));
describe.skipIf(process.platform === 'win32')('test-cli tee contract', () => {
  for (const mode of ['cli', 'docker']) for (const status of [0, 7]) {
    it(mode + ' logs stdout/stderr and preserves review exit ' + status, async () => {
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
        const dockerArguments = join(root, 'docker-args.json');
        await writeFile(join(root, 'docker'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(dockerArguments)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('review stdout\\n'); process.stderr.write('review stderr\\n'); process.exit(Number(process.env.TEST_REVIEW_EXIT));\n`, { mode: 0o700 });
        const cidPrefix = join(root, 'container id');
        const env = { PATH: root + delimiter + process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home,
          TEST_SKIP_BUILD: '1', TEST_DOCKER_CIDFILE: cidPrefix,
          REDLINE_MODEL_AUTH: '{"openrouter":"synthetic-tee-private-key"}', TEST_NODE: node,
          TEST_LOG_DIR: logs, TEST_OUTPUT_DIR: join(root, 'output'), TEST_REVIEW_EXIT: String(status) };
        let code = 0, stdout = '', stderr = '';
        try { const result = await execute('bash', [script, ...(mode === 'docker' ? ['--docker'] : []), 'pi'], { cwd: repo, env }); stdout = result.stdout; stderr = result.stderr; }
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
        if (mode === 'docker') {
          const args: string[] = JSON.parse(await readFile(dockerArguments, 'utf8'));
          expect(args[0]).toBe('run');
          expect(args[args.indexOf('--cidfile') + 1]).toBe(cidPrefix + '-pi');
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});
