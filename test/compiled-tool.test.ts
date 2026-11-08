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
    expect(existsSync(join(tool.root, 'dist/harness-executor/analysis-server.js'))).toBe(true);
    const analysis = await execa(process.execPath, ['--no-strip-types', join(tool.root, 'bin/redline-analysis.mjs')], {
      cwd: tool.root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: tool.root },
      extendEnv: false, preferLocal: false, shell: false, verbose: 'none', reject: false, timeout: 10_000,
      stripFinalNewline: false, maxBuffer: 1024 * 1024,
    });
    expect(analysis.exitCode).toBe(1);
    expect(analysis.stderr).toBe('Optional analysis integration unavailable.\n');
  } finally { await tool.close(); }
  expect(existsSync(tool.root)).toBe(false);
}, 60_000);
