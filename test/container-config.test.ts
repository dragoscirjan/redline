import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CGC_GRAMMAR_MANIFEST_SHA256 } from '../src/code-index/cgc-grammars.ts';

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

  it('stages pinned native CGC grammars during build instead of downloading during a review', async () => {
    const source = await readFile(new URL('../containers/Dockerfile', import.meta.url), 'utf8');
    const loader = await readFile(new URL('../containers/preload-cgc-parsers.py', import.meta.url), 'utf8');
    expect(source).toContain('RUN /opt/cgc/bin/python /opt/harness/preload-cgc-parsers.py');
    expect(source).toContain('TREE_SITTER_LANGUAGE_PACK_LIBS_DIR=/opt/cgc-parsers/v1.22.1');
    expect(loader).toContain(CGC_GRAMMAR_MANIFEST_SHA256);
    expect(loader).toContain('hashlib.sha256(manifest).hexdigest() != MANIFEST_SHA256');
    expect(loader).toContain('prefetch(LANGUAGES)');
    expect(loader).toContain('CGC grammar notices digest mismatch');
    expect(loader).toContain('CGC grammar license digest mismatch');
    expect(loader).toContain('NOTICE.txt');
    expect(loader).toContain('get_parser(language).parse(b"")');
    expect(source.indexOf('preload-cgc-parsers.py')).toBeLessThan(source.indexOf('USER 10001:10001'));
  });

  it('admits only the required container build files, not the whole subtree', async () => {
    const lines = await patterns();
    expect(lines[0]).toBe('**');
    expect(lines.filter(line => line.startsWith('!containers/'))).toEqual([
      '!containers/', '!containers/Dockerfile', '!containers/package.json',
      '!containers/pnpm-lock.yaml', '!containers/requirements.txt', '!containers/preload-cgc-parsers.py',
      '!containers/native-pi-mcp.json', '!containers/native-opencode.json', '!containers/entrypoint.sh',
    ]);
  });

  it('ships matching native MCP defaults without a Redline tool allowlist', async () => {
    const pi = JSON.parse(await readFile(new URL('../containers/native-pi-mcp.json', import.meta.url), 'utf8'));
    const opencode = JSON.parse(await readFile(new URL('../containers/native-opencode.json', import.meta.url), 'utf8'));
    expect(Object.keys(pi.mcpServers).sort()).toEqual(['cgc', 'context-mode', 'gitnexus', 'sequential-thinking']);
    for (const [name, server] of Object.entries(pi.mcpServers) as [string, { command: string; args: string[]; env: Record<string, string> }][]) {
      expect(opencode.mcp[name]).toEqual({ type: 'local', command: [server.command, ...server.args], environment: server.env, enabled: true });
      expect(JSON.stringify(server)).not.toContain('redline-analysis');
    }
    const entry = await readFile(new URL('../containers/entrypoint.sh', import.meta.url), 'utf8');
    expect(entry).toContain('[ ! -e "$pi_dir/mcp.json" ]');
    expect(entry).toContain('[ ! -e "$opencode_dir/opencode.jsonc" ]');
    expect(entry).toContain('exec node /opt/redline/bin/redline.mjs "$@"');
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
