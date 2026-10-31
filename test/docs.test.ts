import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/local/cli.ts';
import { parseLocalOptions } from '../src/local/options.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function doc(path: string): Promise<string> {
  return (await readFile(new URL('../docs/' + path, import.meta.url), 'utf8')).replace(/\r\n?/gu, '\n');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'redline-docs-')); roots.push(root);
  const repository = join(root, 'repo'); await mkdir(repository);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]): string => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '--quiet', '-b', 'main'); git('config', 'user.name', 'Demo'); git('config', 'user.email', 'demo@example.invalid');
  git('config', 'core.autocrlf', 'false');
  await writeFile(join(repository, 'example.ts'), 'export const value = 1;\n');
  git('add', 'example.ts'); git('commit', '--quiet', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await writeFile(join(repository, 'example.ts'), 'export const value = 2;\n');
  git('commit', '--quiet', '-am', 'head');
  await writeFile(join(repository, 'example.ts'), 'export const value = 3;\n'); git('add', 'example.ts');
  await writeFile(join(repository, 'example.ts'), 'export const value = 4;\n');
  await writeFile(join(repository, 'new.ts'), 'export const added = true;\n');
  return { root, repository, env, git };
}

const recipes = [
  ['', []],
  ['--worktree staged', ['--worktree', 'staged']],
  ['--worktree unstaged', ['--worktree', 'unstaged']],
  ['--base origin/main --head HEAD', ['--base', 'origin/main', '--head', 'HEAD']],
  ['--base HEAD~1 --head HEAD --comparison direct', ['--base', 'HEAD~1', '--head', 'HEAD', '--comparison', 'direct']],
  ['--worktree all --untracked include', ['--worktree', 'all', '--untracked', 'include']],
  ['--indexing disabled', ['--indexing', 'disabled']],
  ['--timeout 4m --run-timeout 20m --concurrency 4', ['--timeout', '4m', '--run-timeout', '20m', '--concurrency', '4']],
  ['--retries 1', ['--retries', '1']],
  ['--output ../redline-review-001', ['--output', '../redline-review-001']],
  ['--base origin/main --head HEAD --fail-on high --color never', ['--base', 'origin/main', '--head', 'HEAD', '--fail-on', 'high', '--color', 'never']],
  ['--harness echo --indexing disabled', ['--harness', 'echo', '--indexing', 'disabled']],
] satisfies [string, string[]][];

describe('task-first documentation', () => {
  it.each(recipes)('keeps the documented recipe executable without live models: %s', async (suffix, args) => {
    const command = 'redline review' + (suffix === '' ? '' : ' ' + suffix);
    expect(await doc('commands.md')).toContain('```sh\n' + command + '\n```');
    const f = await fixture(); const before = f.git('status', '--porcelain=v1', '--untracked-files=all');
    const selected = [...args];
    // Test the target-selection/budget recipe while forcing inert review and no external indexer.
    if (!selected.includes('--harness')) selected.push('--harness', 'echo');
    expect(selected[selected.indexOf('--harness') + 1]).toBe('echo');
    if (!selected.includes('--indexing')) selected.push('--indexing', 'disabled');
    expect(selected[selected.indexOf('--indexing') + 1]).toBe('disabled');
    if (!selected.includes('--output')) selected.push('--output', join(f.root, 'review'));
    selected.push('--reuse', 'disabled');
    const output: string[] = [];
    const code = await main(['review', ...selected], f.env, { cwd: f.repository,
      stdout: line => output.push(line), stderr: line => output.push(line) });
    expect(code, output.join('\n')).toBe(0);
    const artifacts = resolve(f.repository, selected[selected.indexOf('--output') + 1] ?? '');
    for (const file of ['reviews/review.md', 'reviews/summary.json', 'capture.json', 'status.json']) await access(join(artifacts, file));
    const manifest: { files: { reviewed: boolean }[] } = JSON.parse(await readFile(join(artifacts, 'bundle/manifest.json'), 'utf8'));
    expect(manifest.files.filter(file => file.reviewed)).toHaveLength(selected.includes('--untracked') ? 2 : 1);
    expect(f.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(before);
  });

  it.each(['pi', 'opencode'])('parses the private configuration example for %s without calling a provider', async (harness) => {
    const examples = [...(await doc('get-started/configuration.md')).matchAll(/```json\n([\s\S]*?)\n```/gu)];
    expect(examples).toHaveLength(2);
    const f = await fixture(); const config = join(f.root, 'private-config.json');
    for (const match of examples) {
      const example = JSON.parse(match[1] ?? ''); example.harness = harness;
      await writeFile(config, JSON.stringify(example), { mode: 0o600 });
      const options = await parseLocalOptions(['--config', config, '--indexing', 'disabled'], f.env, f.repository);
      expect(options.environment.harness).toBe(harness);
    }
  });

  it('makes user tasks searchable and preserves valid reference navigation', async () => {
    const config = await doc('.vitepress/config.ts');
    expect(config).toMatch(/search:\s*\{\s*provider:\s*'local'/u);
    for (const path of ['/get-started/', '/commands', '/results', '/troubleshooting', '/local-cli', '/review-reporting']) {
      expect(config).toContain("link: '" + path + "'");
    }
    const links = [...config.matchAll(/link:\s*'(\/[^']*)'/gu)].map(match => match[1] ?? '');
    for (const link of links) {
      const path = (link.split('#')[0] ?? '/').slice(1);
      await access(new URL('../docs/' + (path.endsWith('/') || path === '' ? path + 'index.md' : path + '.md'), import.meta.url));
    }
    expect(await doc('get-started/first-review.md')).toContain('does not perform model-based code review');
  });

  it('starts GitHub adoption with a pinned, read-only artifact workflow', async () => {
    const source = await doc('get-started/github-actions.md');
    expect(source).toContain('pull_request_target:');
    expect(source).toContain('contents: read');
    expect(source).toMatch(/code-review\.yml@[a-f0-9]{40}/u);
    expect(source).toContain('model-auth: ${{ secrets.MODEL_CREDENTIALS }}');
    expect(source).not.toContain('actions/checkout@');
    expect(source).not.toContain('contents: write');
  });
});
