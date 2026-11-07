import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function patterns(): Promise<string[]> {
  return (await readFile(new URL('../.dockerignore', import.meta.url), 'utf8'))
    .split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
}

describe('Docker build-context contract', () => {
  it('rebuilds only pinned tree-sitter native dependencies while compilers are available', async () => {
    const source = await readFile(new URL('../containers/Dockerfile', import.meta.url), 'utf8');
    const install = source.indexOf('apt-get install -y --no-install-recommends build-essential');
    const rebuild = source.indexOf("npm_config_build_from_source=true CXXFLAGS=-std=c++20 pnpm rebuild --pending");
    const purge = source.indexOf('apt-get purge -y --auto-remove build-essential');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(rebuild).toBeGreaterThan(install);
    expect(rebuild).toBeLessThan(purge);
    expect(source).toContain('pnpm install --frozen-lockfile --prod --ignore-scripts');
    const manifest = JSON.parse(await readFile(new URL('../containers/package.json', import.meta.url), 'utf8'));
    expect(manifest.pnpm.onlyBuiltDependencies).toEqual([
      'tree-sitter', 'tree-sitter-c-sharp', 'tree-sitter-cpp', 'tree-sitter-go', 'tree-sitter-java',
      'tree-sitter-javascript', 'tree-sitter-php', 'tree-sitter-python', 'tree-sitter-ruby',
      'tree-sitter-rust', 'tree-sitter-typescript',
    ]);
    expect(manifest.pnpm.ignoredBuiltDependencies).toEqual(['esbuild']);
  });

  it('installs Redline runtime dependencies from the root lockfile without package scripts', async () => {
    const source = await readFile(new URL('../containers/Dockerfile', import.meta.url), 'utf8');
    const redline = source.slice(source.indexOf('WORKDIR /opt/redline'));
    expect(redline).toContain('COPY package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE ./');
    expect(redline).toContain('RUN pnpm install --frozen-lockfile --prod --ignore-scripts');
  });

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
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE']) expect(lines).toContain('!' + file);
    for (const directory of ['bin', 'src', 'prompts', 'schemas']) {
      expect(lines).toContain('!' + directory + '/');
      expect(lines).toContain('!' + directory + (directory === 'bin' ? '/*.mjs' : '/**'));
    }
  });
});
