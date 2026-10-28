import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { providerCommand } from '../src/local/context.ts';
import { parseLocalOptions } from '../src/local/options.ts';
import { execFileSync } from 'node:child_process';

describe('automatic managed CGC discovery', () => {
  it.skipIf(process.platform !== 'linux' || process.arch !== 'x64').each(['realpath', 'readFile'] as const)(
    'preserves trusted PATH fallback when the optional managed %s probe fails', async (failure) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'redline-tool-test-')));
      try {
        const repository = join(root, 'repository'); await mkdir(repository);
        execFileSync('git', ['init', '--quiet', repository]);
        const bin = join(root, 'bin'); await mkdir(bin);
        const command = join(bin, 'cgc'); await writeFile(command, '#!/bin/sh\nexit 0\n'); await chmod(command, 0o755);
        const managed = join(root, 'state/redline/tools/cgc/0.5.7/linux-x64/cgc');
        await mkdir(join(managed, '..'), { recursive: true }); await writeFile(managed, 'temporary managed fixture');
        const env = { PATH: process.env.PATH, HOME: root, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') };
        const options = await parseLocalOptions(['--harness', 'echo'], env, repository);
        const probe = { realpath: vi.fn((path: string) => realpath(path)), readFile: vi.fn((path: string) => readFile(path)) };
        probe[failure].mockRejectedValue(new Error('controlled managed probe failure'));
        expect(await providerCommand(options, { PATH: bin }, probe)).toEqual({ command, prefix: [] });
        expect(probe[failure]).toHaveBeenCalled();
      } finally { await rm(root, { recursive: true, force: true }); }
    });
});
