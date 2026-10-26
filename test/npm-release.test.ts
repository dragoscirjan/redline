import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { assertNpmVersionAvailable } from '../src/release/npm-check.ts';

/** Inspect this workflow's run values; actionlint owns YAML syntax validation. */
function assertNoInlineVersionInput(source: string): void {
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const run = /^\s*(?:-\s*)?run:\s*(.*)$/u.exec(line);
    if (run === null) continue;
    let script = run[1] ?? '';
    const indent = line.indexOf('run:');
    if (script === '' || /^[|>]/u.test(script)) {
      for (index += 1; index < lines.length; index += 1) {
        const next = lines[index] ?? '';
        if (next.trim() !== '' && next.length - next.trimStart().length <= indent) { index -= 1; break; }
        script += '\n' + next;
      }
    }
    expect(script).not.toMatch(/\binputs\s*(?:\.\s*version\b|\[\s*['"]version['"]\s*\])/u);
  }
}

describe('npm release boundary', () => {
  it.each([
    '${{ inputs.version }}',
    "'${{ inputs.version }}'",
    'echo ${{ inputs.version }}',
    '${{inputs.version}}',
    '${{ inputs . version }}',
    "${{ inputs['version'] }}",
    '${{ inputs["version"] }}',
  ])('rejects a release version expression regardless of quoting or context: %s', (source) => {
    for (const script of ['run: ' + source, 'run: |\n  echo ' + source, 'run: >-\n  echo ' + source]) {
      expect(() => assertNoInlineVersionInput(script)).toThrow();
    }
  });
  it('allows environment handoff while keeping workflow input expressions out of shell scripts', () => {
    const expression = '${{ inputs.version }}';
    for (const source of [
      'env:\n  VERSION: ' + expression + '\nrun: node preflight.ts "$VERSION"',
      'steps:\n  - run: |\n      echo safe\n    env:\n      VERSION: ' + expression + '\n  - run: echo "$VERSION"',
    ]) expect(() => assertNoInlineVersionInput(source)).not.toThrow();
  });

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
    assertNoInlineVersionInput(source);
  });
});
