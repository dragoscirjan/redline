import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function patterns(): Promise<string[]> {
  return (await readFile(new URL('../.dockerignore', import.meta.url), 'utf8'))
    .split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
}

describe('Docker build-context contract', () => {
  it('admits only the required container build files, not the whole subtree', async () => {
    const lines = await patterns();
    expect(lines[0]).toBe('**');
    expect(lines.filter(line => line.startsWith('!containers/'))).toEqual([
      '!containers/', '!containers/Dockerfile', '!containers/package.json',
      '!containers/pnpm-lock.yaml', '!containers/requirements.txt',
    ]);
  });

  it('applies secret and generated-directory exclusions after every allow rule', async () => {
    const lines = await patterns();
    const lastAllow = lines.findLastIndex(line => line.startsWith('!'));
    for (const pattern of ['**/.env', '**/.env.*', '**/secrets', '**/credentials', '**/node_modules', '**/.cache']) {
      expect(lines.indexOf(pattern), pattern).toBeGreaterThan(lastAllow);
    }
  });

  it('includes the complete Redline runtime copied by the Dockerfile', async () => {
    const lines = await patterns();
    for (const file of ['package.json', 'LICENSE']) expect(lines).toContain('!' + file);
    for (const directory of ['bin', 'src', 'prompts', 'schemas']) {
      expect(lines).toContain('!' + directory + '/');
      expect(lines).toContain('!' + directory + (directory === 'bin' ? '/*.mjs' : '/**'));
    }
  });
});
