import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { assertNpmVersionAvailable } from '../src/release/npm-check.ts';

describe('npm release boundary', () => {
  it('requires exact package identity and version before contacting the registry', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(assertNpmVersionAvailable('@dragoscirjan/redline', '1.0.0', '2.0.0', request)).rejects.toThrow('match');
    await expect(assertNpmVersionAvailable('other', '1.0.0', '1.0.0', request)).rejects.toThrow('match');
    expect(request).not.toHaveBeenCalled();
  });
  it.each([200, 401, 429, 500])('fails closed on registry HTTP %s', async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(assertNpmVersionAvailable('@dragoscirjan/redline', '1.0.0', '1.0.0', request)).rejects.toThrow();
  });
  it('allows only an authoritative 404 and propagates network failure', async () => {
    await expect(assertNpmVersionAvailable('@dragoscirjan/redline', '1.0.0', '1.0.0', vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })))).resolves.toBeUndefined();
    await expect(assertNpmVersionAvailable('@dragoscirjan/redline', '1.0.0', '1.0.0', vi.fn<typeof fetch>().mockRejectedValue(new Error('network')))).rejects.toThrow('network');
  });
  it('requires execution on all six native OS and architecture targets', async () => {
    const source = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    for (const target of ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64', 'windows-arm64']) {
      expect(source).toContain(`target: ${target}`);
    }
    expect(source).toContain('process.arch !== process.env.EXPECTED_ARCH');
    expect(source).toContain('test/local-cli.test.ts test/package.test.ts');
  });

  it('gates publishing on main, environment approval, exact-head CI, and offline package verification', async () => {
    const source = await readFile(new URL('../.github/workflows/npm.release.yml', import.meta.url), 'utf8');
    expect(source).toContain("github.ref == 'refs/heads/main'");
    expect(source).toContain('environment: npm-release');
    expect(source).toContain('id-token: write');
    expect(source).toContain('--commit "$GITHUB_SHA"');
    expect(source).toContain('pnpm test');
    expect(source).toContain('npm publish --ignore-scripts --provenance --access public');
    expect(source).not.toContain('${{ inputs.version }}"');
  });
});
