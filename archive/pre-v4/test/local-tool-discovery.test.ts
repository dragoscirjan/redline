import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executable, nativeHarnessCommand } from '../src/local/process.ts';

/** Exercise Windows resolution on every host, without spawning under a substituted platform. */
async function onWindows<T>(operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (descriptor === undefined) throw new Error('Platform descriptor is unavailable');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try { return await operation(); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
}

describe('native harness discovery', () => {
  it.skipIf(process.platform === 'win32')('returns the installed CLI entry point rather than a manual Node launch', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'redline-native-discovery-')));
    try {
      const repository = join(root, 'repository'), bin = join(root, 'bin');
      await Promise.all([mkdir(repository), mkdir(bin)]);
      const command = join(bin, 'pi');
      await writeFile(command, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o700 });
      expect(await executable('pi', bin, repository)).toBe(command);
      expect(await nativeHarnessCommand('pi', bin, repository)).toEqual({ command, prefix: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['script', 'npm', 'exe'] as const)('resolves trusted Windows %s entrypoints without a shell', async kind => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'redline-windows-discovery-')));
    try {
      const repository = join(root, 'repository'), bin = join(root, 'bin');
      await Promise.all([mkdir(repository), mkdir(bin)]);
      const name = kind === 'exe' ? 'opencode' : 'pi';
      let entry: string;
      if (kind === 'npm') {
        const packageRoot = join(bin, 'node_modules/@earendil-works/pi-coding-agent');
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ bin: { pi: 'cli.js' } }));
        entry = join(packageRoot, 'cli.js');
      } else entry = join(bin, kind === 'exe' ? 'opencode.exe' : 'pi');
      await writeFile(entry, kind === 'exe' ? 'native executable placeholder' : '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o700 });
      await onWindows(async () => {
        if (kind !== 'exe') await expect(executable(name, bin, repository)).rejects.toThrow('trusted pi executable not found');
        expect(await nativeHarnessCommand(name, bin, repository)).toEqual(kind === 'exe'
          ? { command: entry, prefix: [] } : { command: process.execPath, prefix: [entry] });
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects repository-local Windows entrypoints', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'redline-windows-boundary-')));
    try {
      const repository = join(root, 'repository'), bin = join(repository, 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'pi'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o700 });
      await onWindows(async () => {
        await expect(nativeHarnessCommand('pi', bin, repository)).rejects.toThrow('trusted pi executable not found');
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
