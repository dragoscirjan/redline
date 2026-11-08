import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareCompiledTool } from './helpers/compiled-tool.ts';

it('prepares a compiled Node CLI for native integration without relying on checkout build output', async () => {
  const tool = await prepareCompiledTool();
  try {
    expect(existsSync(tool.driver)).toBe(true);
    expect(existsSync(join(tool.root, 'dist/local/cli.js'))).toBe(true);
    const result = await execa(process.execPath, ['--no-strip-types', join(tool.root, 'bin/redline.mjs'), '--help'], {
      cwd: tool.root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: tool.root },
      extendEnv: false, preferLocal: false, shell: false, verbose: 'none', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: redline review');
    expect(result.stderr).toBe('');
  } finally { await tool.close(); }
  expect(existsSync(tool.root)).toBe(false);
}, 60_000);
