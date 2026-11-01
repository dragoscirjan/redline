import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNpmVersionAvailable, assertPublishOnlyChangesets } from '../src/release/npm-check.ts';

const roots: string[] = [];
const lineEndings = [['LF', '\n'], ['CRLF', '\r\n']] as const;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function releaseDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'redline-release-')); roots.push(directory);
  await writeFile(join(directory, 'config.json'), '{}');
  return directory;
}

/** Keep workflow checks independent of Git's checkout line endings. */
function workflowText(source: string): string {
  return source.replace(/\r\n?/gu, '\n');
}

/** Inspect this workflow's run values; actionlint owns YAML syntax validation. */
function assertNoInlineVersionInput(source: string): void {
  const lines = workflowText(source).split('\n');
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
      for (const [, newline] of lineEndings) {
        expect(() => assertNoInlineVersionInput(script.replace(/\n/gu, newline))).toThrow();
      }
    }
  });
  it('allows environment handoff while keeping workflow input expressions out of shell scripts', () => {
    const expression = '${{ inputs.version }}';
    for (const source of [
      'env:\n  VERSION: ' + expression + '\nrun: node preflight.ts "$VERSION"',
      'steps:\n  - run: |\n      echo safe\n    env:\n      VERSION: ' + expression + '\n  - run: echo "$VERSION"',
    ]) {
      for (const [, newline] of lineEndings) {
        expect(() => assertNoInlineVersionInput(source.replace(/\n/gu, newline))).not.toThrow();
      }
    }
  });

  it('accepts only the consumed Changesets configuration and optional README', async () => {
    const directory = await releaseDirectory();
    await expect(assertPublishOnlyChangesets(directory)).resolves.toBeUndefined();
    await writeFile(join(directory, 'README.md'), '# Release notes');
    await expect(assertPublishOnlyChangesets(directory)).resolves.toBeUndefined();
  });
  it.each(['pending.md', 'pre.json', 'unexpected.json'])('blocks publication with %s present', async (name) => {
    const directory = await releaseDirectory(); await writeFile(join(directory, name), 'fixture');
    await expect(assertPublishOnlyChangesets(directory)).rejects.toThrow('consume pending Changesets');
  });
  it('rejects missing configuration and directories disguised as allowed files', async () => {
    const directory = await releaseDirectory(); await rm(join(directory, 'config.json'));
    await expect(assertPublishOnlyChangesets(directory)).rejects.toThrow();
    await mkdir(join(directory, 'config.json'));
    await expect(assertPublishOnlyChangesets(directory)).rejects.toThrow();
    await expect(assertPublishOnlyChangesets(join(directory, 'absent'))).rejects.toThrow();
  });

  it('handles clean main and consumes version notes with the real Changesets 3 CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-changesets-')); roots.push(root);
    await mkdir(join(root, '.changeset'));
    await writeFile(join(root, '.changeset/config.json'), await readFile(new URL('../.changeset/config.json', import.meta.url)));
    await writeFile(join(root, '.changeset/README.md'), await readFile(new URL('../.changeset/README.md', import.meta.url)));
    await writeFile(join(root, 'pnpm-workspace.yaml'), await readFile(new URL('../pnpm-workspace.yaml', import.meta.url)));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@dragoscirjan/redline', version: '1.0.0' }));
    await writeFile(join(root, '.gitignore'), 'node_modules\n');
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'missing-config') };
    for (const args of [
      ['init', '--initial-branch', 'main'], ['add', 'package.json', '.changeset', 'pnpm-workspace.yaml', '.gitignore'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null',
        '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: seed main'],
    ]) {
      const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    }
    const cli = fileURLToPath(new URL('../node_modules/@changesets/cli/bin.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'status'], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    await writeFile(join(root, '.changeset/release-test.md'), '---\n"@dragoscirjan/redline": patch\n---\nFixture automated release.\n');
    await expect(assertPublishOnlyChangesets(join(root, '.changeset'))).rejects.toThrow('consume pending Changesets');
    const versioned = spawnSync(process.execPath, [cli, 'version'], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
    expect(versioned.status, versioned.stderr + versioned.stdout).toBe(0);
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('1.0.1');
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toContain('Fixture automated release.');
    await expect(assertPublishOnlyChangesets(join(root, '.changeset'))).resolves.toBeUndefined();
  });

  it('uses the reviewed manifest version by default and ignores ambient VERSION without registry access', async () => {
    const source = new URL('../src/release/npm-check.ts', import.meta.url);
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const root = await mkdtemp(join(tmpdir(), 'redline-release-version-')); roots.push(root);
    await mkdir(join(root, 'src/release'), { recursive: true }); await mkdir(join(root, '.changeset'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, type: 'module' }));
    await writeFile(join(root, '.changeset/config.json'), '{}');
    const file = pathToFileURL(join(root, 'src/release/npm-check.ts'));
    await writeFile(file, await readFile(source));
    for (const explicit of [false, true]) {
      const script = `globalThis.fetch = async () => new Response('', { status: 404 });
        process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(file))}${explicit ? ', ' + JSON.stringify(metadata.version) : ''}];
        await import(${JSON.stringify(file.href)});`;
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, VERSION: 'invalid' },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
    }
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
    const source = workflowText(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    for (const target of ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64', 'windows-arm64']) {
      expect(source).toContain(`target: ${target}`);
    }
    expect(source).toContain('process.arch !== process.env.EXPECTED_ARCH');
    expect(source).toContain('test/local-cli.test.ts test/package.test.ts');
  });

  it.each(lineEndings)('runs release after every required main CI check, never on PRs or dispatches (%s)', async (_label, newline) => {
    const source = workflowText((await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r?\n/gu, newline));
    const release = source.split('\n  release:\n')[1]?.split(/\n  [a-z][a-z-]*:\n/u)[0] ?? '';
    expect(release).toContain('needs: [validate, harness-matrix, source-runtime, local-cli, container-workers, candidate-provenance]');
    expect(release).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(release).toContain("github.repository == 'dragoscirjan/redline'");
    expect(release).toContain('uses: ./.github/workflows/npm.release.yml');
    expect(release).toContain('NPM_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(release).not.toContain('secrets: inherit');
    for (const permission of ['actions: write', 'contents: write', 'pull-requests: write', 'packages: write', 'attestations: write', 'id-token: write']) {
      expect(release).toContain(permission);
    }
    expect(source.split('\njobs:')[0]).toContain('permissions:\n  contents: read');
  });

  it.each(lineEndings)('supports version, publish and no-op modes with isolated credentials (%s)', async (_label, newline) => {
    const source = workflowText((await readFile(new URL('../.github/workflows/npm.release.yml', import.meta.url), 'utf8')).replace(/\r?\n/gu, newline));
    expect(source).toContain("github.ref == 'refs/heads/main'");
    expect(source).toContain('environment: npm-release');
    expect(source).toContain('id-token: write');
    expect(source).toContain('workflow_call:');
    expect(source).toContain('NPM_TOKEN:\n        required: true');
    expect(source).toContain("github.event_name == 'push'");
    expect(source).not.toContain('workflow_dispatch:');
    expect(source).not.toContain('gh run list');
    expect(source).not.toContain('inputs.version');
    expect(source).not.toContain('run: node src/release/npm-check.ts');
    expect(source).toContain('dragoscirjan/tempel-javascript/.github/actions/release@71e3379b37d477ae0e7915f6463b0a3921d28f8d');
    expect(source).toContain('fetch-depth: 0');
    expect(source).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(source.match(/secrets\.NPM_TOKEN/gu)).toHaveLength(2);
    expect(source.indexOf('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}')).toBeGreaterThan(source.indexOf('- name: Install frozen dependencies'));
    expect(source).toContain("if: steps.plan.outputs.mode == 'version'");
    expect(source).toContain("npm_config_ignore_scripts: 'true'");
    expect(source).toContain("npm_config_provenance: 'true'");
    expect(source).toContain("npm_config_access: public");
    expect(source).toContain('run: node src/release/main.ts publish');
    expect(source).toContain('run: node src/release/main.ts restore');
    expect(source).toContain('run: node src/release/main.ts finalize');
    expect(source).toContain('artifact-ids: ${{ needs.plan.outputs.candidate-id }}');
    expect(source).toContain('run-id: ${{ needs.plan.outputs.run-id }}');
    expect(source).not.toContain('outputs.published');
    expect(source).toContain("if: steps.version.outputs.pr-number != ''");
    const verification = source.split('\n  verify:\n')[1]?.split('\n  finalize:\n')[0] ?? '';
    expect(verification).toContain('run: node src/release/main.ts install');
    expect(verification).toContain('REDLINE_CONTAINER_CLI: ${{ steps.installation.outputs.binary }}');
    expect(verification).toContain('runner: ubuntu-24.04-arm');
    expect(verification).not.toMatch(/NPM_TOKEN|GH_TOKEN|id-token: write|packages: write/u);
    const finalization = source.split('\n  finalize:\n')[1] ?? '';
    expect(finalization).toContain('needs: [prepare, publish, verify]');
    expect(finalization).not.toMatch(/NPM_TOKEN|id-token: write|packages: write/u);
    expect(source).toContain('gh workflow run ci.yml --ref "$head_ref"');
    expect(source).not.toContain('gh pr merge');
    expect(source).not.toContain('gh pr review');
    const config = JSON.parse(await readFile(new URL('../.github/release.json', import.meta.url), 'utf8'));
    expect(config).toMatchObject({ version: 1, engine: 'changesets', publishing: {
      before: ['release:preflight'], create_github_releases: false, push_git_tags: false,
    }, pull_request: { title: 'chore(release): version package', commit_message: 'chore(release): version package', base_branch: 'main' } });
    const changesets = JSON.parse(await readFile(new URL('../.changeset/config.json', import.meta.url), 'utf8'));
    expect(changesets).toMatchObject({ access: 'public', baseBranch: 'main', commit: false });
    assertNoInlineVersionInput(source);
  });
});
