import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reviewFinding } from './helpers/finding.ts';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/local/cli.ts';
import { parseLocalOptions } from '../src/local/options.ts';
import { GitRevisionSource } from '../src/local/git-source.ts';
import { terminalText } from '../src/local/reporter.ts';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'redline-local-test-'))); roots.push(root);
  const repository = join(root, 'repo'); await mkdir(repository);
  const git = (...args: string[]): string => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, TEMP: root, TMP: root,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git('init', '--quiet', '-b', 'main', '--object-format=' + objectFormat); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@localhost');
  await writeFile(join(repository, 'example.ts'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'example.ts'), 'export const value = 2;\n');
  git('commit', '--quiet', '-am', 'head');
  const head = git('rev-parse', 'HEAD');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  let runs = 0;
  const run = async (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => {
    const output = join(root, `output-${runs++}`); const stdout: string[] = []; const stderr: string[] = [];
    const code = await main(['review', '--harness', 'echo', '--indexing', 'disabled', '--output', output, ...args], { ...env, ...overrides }, {
      cwd: repository, stdout: (line) => { stdout.push(line); }, stderr: (line) => { stderr.push(line); },
    });
    return { code, output, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  };
  return { root, repository, git, base, head, env, run };
}
async function manifest(output: string) { return JSON.parse(await readFile(join(output, 'bundle/manifest.json'), 'utf8')); }
async function capture(output: string) { return JSON.parse(await readFile(join(output, 'capture.json'), 'utf8')); }

describe('local Git review CLI', () => {
  it('automatically resumes exact validated results and invalidates budget and source changes', async () => {
    const f = await fixture();
    const args = ['--base', f.base, '--head', 'HEAD'];
    const first = await f.run(args); expect(first.code, first.stderr).toBe(0);
    const summary = async (output: string) => JSON.parse(await readFile(join(output, 'reviews/summary.json'), 'utf8'));
    expect((await summary(first.output)).reuse).toMatchObject({ reusedFiles: 0, executedFiles: 1 });
    const second = await f.run(args); expect(second.code, second.stderr).toBe(0);
    expect((await summary(second.output)).reuse).toMatchObject({ reusedFiles: 1, executedFiles: 0 });
    expect(second.stdout).toMatch(/Reuse:\s+1 validated file reused; 0 executed/u);
    const disabled = await f.run([...args, '--reuse', 'disabled']);
    expect((await summary(disabled.output)).reuse.status).toBe('disabled');
    const budget = await f.run([...args, '--max-output-tokens', '32768']);
    expect((await summary(budget.output)).reuse.reusedFiles).toBe(0);
    await writeFile(join(f.repository, 'example.ts'), 'export const value = 3;\n');
    f.git('commit', '--quiet', '-am', 'changed');
    const changed = await f.run(args);
    expect((await summary(changed.output)).reuse.reusedFiles).toBe(0);
  });

  it('discards corrupt result records and never follows a symlinked cache root', async () => {
    const f = await fixture(); const args = ['--base', f.base, '--head', 'HEAD'];
    const first = await f.run(args); expect(first.code).toBe(0);
    const root = join(f.root, 'state/redline/results/v1');
    const { readdir } = await import('node:fs/promises');
    const [namespace] = await readdir(root); const entries = join(root, namespace!, 'entries');
    const [entry] = await readdir(entries); await writeFile(join(entries, entry!), '{}');
    const second = await f.run(args);
    const summary = JSON.parse(await readFile(join(second.output, 'reviews/summary.json'), 'utf8'));
    expect(summary.reuse).toMatchObject({ reusedFiles: 0, executedFiles: 1, invalidEntries: 1 });
    await rm(join(f.root, 'state/redline/results'), { recursive: true });
    const outside = join(f.root, 'outside-cache'); await mkdir(outside);
    try { await symlink(outside, join(f.root, 'state/redline/results'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { return; }
    const third = await f.run(args); expect(third.code).toBe(0); expect(third.stderr).toContain('Review reuse: unavailable');
    expect(await readdir(outside)).toEqual([]);
  });

  it('captures static import/test evidence for a newly added file without any indexer', async () => {
    const f = await fixture();
    await writeFile(join(f.repository, 'new.ts'), 'export const result = 1;\n');
    await writeFile(join(f.repository, 'new.test.ts'), "import { result } from './new';\n// TEST_SENTINEL\n");
    f.git('add', '.'); f.git('commit', '--quiet', '-m', 'new source and test');
    const result = await f.run(['--base', f.base, '--head', 'HEAD']); expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(await readFile(join(result.output, 'reviews/summary.json'), 'utf8'));
    expect(summary.codeContext.diagnosticCodes).toContain('static-head-context');
    expect(summary.files.find((file: { path: string }) => file.path === 'new.ts').codeContext.provider.id).toBe('static-head');
    expect(result.stderr).toContain('Static head context:');
  });

  it('applies new non-secret options with flag > environment > trusted configuration precedence', async () => {
    const f = await fixture(); const path = join(f.root, 'user.json');
    await writeFile(path, JSON.stringify({ reuse: 'disabled', scheduling: 'mixed', 'head-context': 'disabled', 'model-protocol': 'openrouter-json' }));
    const parse = (args: string[], env: NodeJS.ProcessEnv = {}) => parseLocalOptions(['--harness', 'echo', '--config', path, ...args], { ...f.env, ...env }, f.repository);
    const defaults = await parse([]);
    expect(defaults.reuse).toBe('disabled'); expect(defaults.environment).toMatchObject({ scheduling: 'mixed', headContext: false, modelProtocol: 'openrouter-json' });
    const environment = await parse([], { REDLINE_REUSE: 'enabled', REDLINE_MODEL_PROTOCOL: 'compatible' });
    expect(environment.reuse).toBe('enabled'); expect(environment.environment.modelProtocol).toBe('compatible');
    const flags = await parse(['--reuse', 'disabled', '--scheduling', 'largest-first', '--head-context', 'enabled'], { REDLINE_REUSE: 'enabled' });
    expect(flags.reuse).toBe('disabled'); expect(flags.environment).toMatchObject({ scheduling: 'largest-first', headContext: true });
  });

  it('rejects an unavailable protocol rather than downgrading it or making a model call', async () => {
    const f = await fixture(); const result = await f.run(['--model-protocol', 'openrouter-json']);
    expect(result.code).toBe(1); expect(result.stderr).toContain('requires the Pi harness');
  });

  it('defaults to three additional retries and honors flag, environment and trusted config precedence', async () => {
    const f = await fixture();
    expect((await parseLocalOptions(['--harness', 'echo'], f.env, f.repository)).environment.retries).toBe(3);
    const config = join(f.root, 'retry-config.json');
    await writeFile(config, JSON.stringify({ retries: '2' }));
    const parse = (args: string[], env: NodeJS.ProcessEnv = {}) => parseLocalOptions(['--harness', 'echo', '--config', config, ...args], { ...f.env, ...env }, f.repository);
    expect((await parse([])).environment.retries).toBe(2);
    expect((await parse([], { REDLINE_RETRIES: '1' })).environment.retries).toBe(1);
    expect((await parse(['--retries', '0'], { REDLINE_RETRIES: '1' })).environment.retries).toBe(0);
    const result = await f.run(['--base', f.base, '--head', 'HEAD', '--retries', '0', '--timeout', '2m', '--run-timeout', '8m']);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(await readFile(join(result.output, 'reviews/summary.json'), 'utf8'));
    expect(report.retries).toMatchObject({ limit: 0, attempts: 1 });
    expect(report.executionBudget).toMatchObject({ fileTimeoutMs: 120_000 });
  });

  it.each(['-1', '11', '1.5', 'Infinity', '', ' 3', '03'])('rejects invalid retry count %s before creating output', async (value) => {
    const f = await fixture(); const result = await f.run([`--retries=${value}`]);
    expect(result.code).toBe(2);
    expect(await readFile(join(result.output, 'status.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('applies output-token budget precedence and records the explicit allowance', async () => {
    const f = await fixture(); const config = join(f.root, 'user.json');
    await writeFile(config, JSON.stringify({ 'max-output-tokens': '32768' }));
    const parse = (args: string[], env: NodeJS.ProcessEnv = {}) => parseLocalOptions(['--harness', 'echo', '--config', config, ...args], { ...f.env, ...env }, f.repository);
    expect((await parse([])).environment.maxOutputTokens).toBe(32768);
    expect((await parse([], { REDLINE_MAX_OUTPUT_TOKENS: '65536' })).environment.maxOutputTokens).toBe(65536);
    expect((await parse(['--max-output-tokens', '131072'], { REDLINE_MAX_OUTPUT_TOKENS: '65536' })).environment.maxOutputTokens).toBe(131072);
    const result = await f.run(['--max-output-tokens', '32768']);
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain('Output budget: 32768 tokens per model call');
    expect(JSON.parse(await readFile(join(result.output, 'status.json'), 'utf8')).maxOutputTokens).toBe(32768);
  });

  it.each(['0', '1023', '262145', '1.5', '-1', 'Infinity', '32k', ' 32768'])('rejects invalid output-token allowance %s before creating output', async (value) => {
    const f = await fixture(); const result = await f.run([`--max-output-tokens=${value}`]);
    expect(result.code).toBe(2); expect(result.stderr).toContain('max-output-tokens');
    expect(await readFile(join(result.output, 'status.json'), 'utf8').catch(() => null)).toBeNull();
  });
  it('reviews branches without forge metadata and preserves deterministic bundle bytes', async () => {
    const f = await fixture();
    f.git('branch', 'base', f.base); f.git('branch', 'feature', f.head);
    const one = await f.run(['--base', 'base', '--head', 'feature']);
    expect(one.code, one.stderr).toBe(0);
    expect(one.stdout).toContain('Verdict:'); expect(one.stdout).toContain('Artifacts:');
    const two = await f.run(['--base', f.base, '--head', f.head]);
    expect(two.code, two.stderr).toBe(0);
    expect(await readFile(join(one.output, 'bundle/manifest.json'), 'utf8')).toBe(await readFile(join(two.output, 'bundle/manifest.json'), 'utf8'));
    expect(await readFile(join(one.output, 'bundle/diffs/000001.diff'), 'utf8')).toBe(await readFile(join(two.output, 'bundle/diffs/000001.diff'), 'utf8'));
    expect((await manifest(one.output)).base).toBe(f.base);
  });

  it('defaults to merge-base and supports exact direct tree comparisons', async () => {
    const f = await fixture();
    f.git('checkout', '--quiet', '-b', 'other', f.base);
    await writeFile(join(f.repository, 'other.ts'), 'base branch only\n'); f.git('add', '.'); f.git('commit', '--quiet', '-m', 'other');
    const other = f.git('rev-parse', 'HEAD');
    const merge = await f.run(['--base', other, '--head', f.head]);
    const direct = await f.run(['--base', other, '--head', f.head, '--comparison', 'direct']);
    expect(merge.code, merge.stderr).toBe(0); expect(direct.code, direct.stderr).toBe(0);
    expect((await manifest(merge.output)).base).toBe(f.base);
    expect((await manifest(merge.output)).files).toHaveLength(1);
    expect((await manifest(direct.output)).base).toBe(other);
    expect((await manifest(direct.output)).files).toHaveLength(2);
  });

  it.each(['sha1', 'sha256'] as const)('preserves %s shallow boundaries for committed and synthetic captures', async (objectFormat) => {
    const f = await fixture(objectFormat);
    await writeFile(join(f.repository, 'example.ts'), 'export const value = 3;\n');
    f.git('commit', '--quiet', '-am', 'common'); const common = f.git('rev-parse', 'HEAD');
    await writeFile(join(f.repository, 'main.ts'), 'export const main = true;\n');
    f.git('add', '.'); f.git('commit', '--quiet', '-m', 'main change');
    f.git('checkout', '--quiet', '-b', 'topic', common);
    await writeFile(join(f.repository, 'topic.ts'), 'export const topic = true;\n');
    f.git('add', '.'); f.git('commit', '--quiet', '-m', 'topic change'); f.git('checkout', '--quiet', 'main');
    const shallow = join(f.root, 'shallow');
    f.git('clone', '--quiet', '--depth', '2', '--no-single-branch', pathToFileURL(f.repository).href, shallow);
    const boundary = join(shallow, '.git/shallow'); const before = await readFile(boundary);
    const indexBefore = await readFile(join(shallow, '.git/index'));
    const committed = await f.run(['--repository', shallow, '--base', 'origin/topic', '--head', 'HEAD']);
    expect(committed.code, committed.stderr).toBe(0);
    expect((await manifest(committed.output)).base).toBe(common);
    expect((await manifest(committed.output)).files.map((file: { newPath: string }) => file.newPath)).toEqual(['main.ts']);
    const linked = join(f.root, 'linked-shallow-worktree');
    f.git('-C', shallow, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD');
    const linkedReview = await f.run(['--repository', linked, '--base', 'origin/topic', '--head', 'HEAD']);
    expect(linkedReview.code, linkedReview.stderr).toBe(0);
    expect((await manifest(linkedReview.output)).base).toBe(common);
    await writeFile(join(shallow, 'example.ts'), 'working shallow snapshot\n');
    const working = await f.run(['--repository', shallow]);
    expect(working.code, working.stderr).toBe(0);
    expect(await readFile(join(working.output, 'source/example.ts'), 'utf8')).toBe('working shallow snapshot\n');
    expect(await readFile(boundary)).toEqual(before);
    expect(await readFile(join(shallow, '.git/index'))).toEqual(indexBefore);
  });

  it.each(['malformed', 'oversized'] as const)('rejects %s shallow metadata before review', async (kind) => {
    const f = await fixture(); const boundary = join(f.repository, '.git/shallow');
    await writeFile(boundary, kind === 'malformed' ? f.head + ' trailing-data\n' : 'a'.repeat(20_000 * 42 + 1));
    const result = await f.run(['--base', f.head, '--head', f.head]);
    expect(result.code).toBe(1); expect(result.stderr).toContain('Git shallow boundary');
    expect(await readFile(join(result.output, 'reviews/summary.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked shallow boundary without modifying its temporary target', async () => {
    const f = await fixture(); const target = join(f.root, 'boundary-target');
    await writeFile(target, f.head + '\n');
    await symlink(target, join(f.repository, '.git/shallow'));
    const result = await f.run(['--base', f.head, '--head', f.head]);
    expect(result.code).toBe(1); expect(result.stderr).toContain('unsafe or oversized Git shallow boundary');
    expect(await readFile(target, 'utf8')).toBe(f.head + '\n');
  });

  it('rejects shallow boundary changes during capture', async () => {
    const f = await fixture();
    const options = await parseLocalOptions(['--harness', 'echo'], f.env, f.repository);
    const output = join(f.root, 'capture-shallow'); await mkdir(output);
    const { GitCommand } = await import('../src/local/process.ts');
    const original = GitCommand.prototype.run; let changed = false;
    vi.spyOn(GitCommand.prototype, 'run').mockImplementation(async function (this: InstanceType<typeof GitCommand>, args, input, env) {
      const value = await original.call(this, args, input, env);
      if (args[0] === 'ls-tree' && !changed) { changed = true; await writeFile(join(f.repository, '.git/shallow'), f.head + '\n'); }
      return value;
    });
    await expect(new GitRevisionSource(options, f.env, output).capture(new AbortController().signal)).rejects.toThrow('Git shallow boundary changed during capture');
    expect(changed).toBe(true);
  });

  it('defaults to HEAD versus combined tracked changes and excludes untracked files', async () => {
    const f = await fixture();
    await writeFile(join(f.repository, 'example.ts'), 'staged\n'); f.git('add', '.');
    await writeFile(join(f.repository, 'example.ts'), 'unstaged\n');
    await writeFile(join(f.repository, 'secret.txt'), 'untracked secret\n');
    const result = await f.run(); expect(result.code, result.stderr).toBe(0);
    expect(await readFile(join(result.output, 'source/example.ts'), 'utf8')).toBe('unstaged\n');
    expect((await capture(result.output)).excludedUntracked).toEqual(['secret.txt']);
    expect((await manifest(result.output)).files).toHaveLength(1);
    expect(await readFile(join(result.output, 'source/secret.txt'), 'utf8').catch(() => null)).toBeNull();
  });

  it.each(['staged', 'unstaged', 'all'])('captures exact %s state without modifying the index', async (mode) => {
    const f = await fixture();
    await writeFile(join(f.repository, 'example.ts'), 'staged\n'); f.git('add', '.');
    await writeFile(join(f.repository, 'example.ts'), 'unstaged\n');
    const before = await readFile(join(f.repository, '.git/index'));
    const result = await f.run(['--worktree', mode]); expect(result.code, result.stderr).toBe(0);
    expect(await readFile(join(result.output, 'source/example.ts'), 'utf8')).toBe(mode === 'staged' ? 'staged\n' : 'unstaged\n');
    const patch = await readFile(join(result.output, 'bundle/diffs/000001.diff'), 'utf8');
    expect(patch).toContain(mode === 'unstaged' ? '-staged' : '-export const value = 2;');
    expect(await readFile(join(f.repository, '.git/index'))).toEqual(before);
  });

  it('opts into untracked files and handles renamed, deleted, binary, mode, and symlink data', async () => {
    const f = await fixture();
    await rename(join(f.repository, 'example.ts'), join(f.repository, 'renamed.ts')); f.git('add', '-A');
    await writeFile(join(f.repository, 'new.ts'), 'new file\n');
    await writeFile(join(f.repository, 'binary.dat'), Buffer.from([0, 1, 2]));
    const sentinel = join(f.root, 'sentinel.txt');
    await writeFile(sentinel, 'temporary fixture sentinel: must never enter captured source\n');
    await symlink(sentinel, join(f.repository, 'link'), 'file');
    const result = await f.run(['--untracked', 'include']); expect(result.code, result.stderr).toBe(0);
    const files = (await manifest(result.output)).files;
    expect(files.some((item: { status: string }) => item.status === 'R')).toBe(true);
    expect(files.some((item: { binary: boolean }) => item.binary)).toBe(true);
    expect((await capture(result.output)).symlinks).toEqual([{ path: 'link', target: sentinel }]);
    expect(await readFile(join(result.output, 'source/link')).catch(() => null)).toBeNull();
  });

  it('does not execute repository filters, text converters, external diff, hooks, or fsmonitor', async () => {
    const f = await fixture();
    const marker = join(f.root, 'executed');
    f.git('config', 'diff.external', `touch ${marker}`);
    f.git('config', 'diff.evil.textconv', `touch ${marker}`);
    f.git('config', 'filter.evil.clean', `touch ${marker}`);
    f.git('config', 'core.fsmonitor', `touch ${marker}`);
    await writeFile(join(f.repository, '.gitattributes'), '*.ts diff=evil filter=evil\n');
    await writeFile(join(f.repository, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`); await chmod(join(f.repository, '.git/hooks/post-checkout'), 0o755);
    const result = await f.run(['--base', f.base, '--head', f.head]);
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(marker).catch(() => null)).toBeNull();
    const worktree = await f.run(); expect(worktree.code, worktree.stderr).toBe(0);
    expect(await readFile(marker).catch(() => null)).toBeNull();
  });

  it.each([['--vcs', 'jj'], ['--vcs', 'mercurial'], ['--reporter', 'github'], ['--reporter', 'forgejo'], ['--reporter', 'gitea'], ['--reporter', 'gitlab'], ['--reporter', 'bitbucket']])('rejects unavailable %s %s before output creation', async (...args) => {
    const f = await fixture(); const result = await f.run(args);
    expect(result.code).toBe(4); expect(result.stderr).toContain('not implemented');
    expect(await readFile(join(result.output, 'status.json')).catch(() => null)).toBeNull();
  });

  it.each([['--head', 'HEAD', '--worktree', 'all'], ['--comparison', 'direct'], ['--worktree', 'staged', '--untracked', 'include'], ['--api-key', 'do-not-print'], ['--concurrency', '9'], ['--color', 'rainbow']])('rejects invalid arguments without leaking values: %s', async (...args) => {
    const f = await fixture(); const result = await f.run(args); expect(result.code).toBe(2);
    expect(result.stderr).not.toContain('do-not-print');
  });

  it('uses trusted user config, applies flag/env precedence, and refuses repository config', async () => {
    const f = await fixture(); await mkdir(join(f.root, 'config/redline'), { recursive: true });
    await writeFile(join(f.root, 'config/redline/config.json'), JSON.stringify({ harness: 'echo', concurrency: '2', timeout: '3m' }));
    const options = await parseLocalOptions(['--concurrency', '1'], { ...f.env, REDLINE_REVIEW_CONCURRENCY: '3' }, f.repository);
    expect(options.environment.reviewConcurrency).toBe(1); expect(options.environment.timeout.minutes).toBe(3);
    await writeFile(join(f.repository, 'config.json'), JSON.stringify({ endpoint: 'https://untrusted.invalid' }));
    await expect(parseLocalOptions(['--config', 'config.json'], f.env, f.repository)).rejects.toThrow('outside');
  });

  it('records deletions and handles a detached HEAD and no-change review', async () => {
    const f = await fixture(); f.git('checkout', '--quiet', '--detach'); await rm(join(f.repository, 'example.ts'));
    const deleted = await f.run(); expect(deleted.code, deleted.stderr).toBe(0);
    expect((await manifest(deleted.output)).files[0].status).toBe('D');
    const empty = await f.run(['--base', f.head, '--head', f.head]); expect(empty.code, empty.stderr).toBe(0);
    expect((await manifest(empty.output)).files).toEqual([]);
  });

  it('rejects missing revisions and an existing output directory', async () => {
    const f = await fixture(); const bad = await f.run(['--head', 'does-not-exist']); expect(bad.code).toBe(1);
    expect(JSON.parse(await readFile(join(bad.output, 'status.json'), 'utf8')).status).toBe('failed');
    const result = await f.run(['--output', f.repository]); expect(result.code).toBe(1);
  });

  it.each(['existing', 'missing-parent', 'inside-repository', 'file-parent'] as const)('explains %s output failures without echoing argument values', async (kind) => {
    const f = await fixture();
    const sensitive = 'private-output-name';
    const existing = join(f.root, sensitive); await mkdir(existing);
    const file = join(f.root, 'parent-file'); await writeFile(file, 'fixture');
    const path = kind === 'existing' ? existing : kind === 'missing-parent' ? join(f.root, 'absent', sensitive)
      : kind === 'inside-repository' ? join(f.repository, sensitive) : join(file, sensitive);
    const expected = kind === 'existing' ? 'output directory already exists'
      : kind === 'inside-repository' ? 'output must be outside the reviewed repository' : 'output parent directory is unavailable';
    const result = await f.run(['--output', path]);
    expect(result.code).toBe(1); expect(result.stderr).toContain(expected);
    expect(result.stderr).not.toContain(sensitive); expect(result.stderr).toContain('no output created');
    expect(await readFile(join(path, 'status.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('loads eligibility from the committed base, not uncommitted policy', async () => {
    const f = await fixture();
    await mkdir(join(f.repository, '.redline')); await writeFile(join(f.repository, '.redline/review-eligibility.json'), '{invalid');
    await writeFile(join(f.repository, 'example.ts'), 'changed\n');
    const result = await f.run(); expect(result.code, result.stderr).toBe(0);
    expect((await manifest(result.output)).eligibility.source).toBe('built-in');
  });

  it.each(['staged', 'unstaged', 'all'] as const)('ignores staged exclusion policy in %s review and trusts the committed base', async (mode) => {
    const f = await fixture();
    await mkdir(join(f.repository, '.redline'));
    await writeFile(join(f.repository, '.redline/review-eligibility.json'), JSON.stringify({
      version: 1, include: [], exclude: [{ pattern: 'example.ts', reason: 'attempted staged exclusion' }],
    }));
    await writeFile(join(f.repository, 'example.ts'), 'staged change\n'); f.git('add', '.');
    await writeFile(join(f.repository, 'example.ts'), 'unstaged change\n');
    const result = await f.run(['--base', f.head, '--worktree', mode]);
    expect(result.code, result.stderr).toBe(0);
    const bundle = await manifest(result.output);
    expect(bundle.eligibility.source).toBe('built-in');
    expect(bundle.files.find((file: { newPath: string }) => file.newPath === 'example.ts').reviewed).toBe(true);
    if (mode === 'unstaged') expect(bundle.base).not.toBe(f.head);
  });

  it('rejects an externally supplied policy-base override before capture', async () => {
    const f = await fixture(); const result = await f.run(['--policy-base', 'HEAD']);
    expect(result.code).toBe(2); expect(result.stderr).toContain('invalid arguments');
    expect(await readFile(join(result.output, 'capture.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('detects file changes during capture rather than reviewing a mixed snapshot', async () => {
    const f = await fixture(); await writeFile(join(f.repository, 'example.ts'), 'before\n');
    const options = await parseLocalOptions(['--harness', 'echo'], f.env, f.repository);
    const output = join(f.root, 'capture'); await mkdir(output);
    // Mutate after the first captured file is hashed, before the second scan.
    const { GitCommand } = await import('../src/local/process.ts');
    const original = GitCommand.prototype.run;
    let mutated = false;
    vi.spyOn(GitCommand.prototype, 'run').mockImplementation(async function (this: InstanceType<typeof GitCommand>, args, input, env) {
      const value = await original.call(this, args, input, env);
      if (args[0] === 'hash-object' && !mutated) { mutated = true; await writeFile(join(f.repository, 'example.ts'), 'after\n'); }
      return value;
    });
    await expect(new GitRevisionSource(options, f.env, output).capture(new AbortController().signal)).rejects.toThrow('changed during capture');
  });

  it.each([['none', 0], ['findings', 3], ['high', 0], ['critical', 0]])('applies finding exit policy %s to validated findings', async (policy, expected) => {
    const f = await fixture(); const bin = join(f.root, 'bin'); await mkdir(bin);
    const finding = reviewFinding({ evidence: 'export const value = 2;' });
    const document = { version: 3, fileId: '000001', outcome: 'findings', findings: [finding] };
    const event = { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(document) }], stopReason: 'stop' } };
    await writeFile(join(bin, 'pi'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(event) + '\n')});\n`); await chmod(join(bin, 'pi'), 0o755);
    const result = await f.run(['--harness', 'pi', '--provider', 'mock', '--endpoint', 'http://127.0.0.1:1/v1', '--model', 'fixture', '--auth', 'none',
      '--base', f.base, '--head', f.head, '--fail-on', String(policy)], { PATH: bin + delimiter + process.env.PATH });
    expect(result.code, result.stderr).toBe(expected);
    expect(result.stdout).toContain('example.ts\n  MEDIUM defect, 1-1 [RIGHT]');
    expect(result.stdout).toContain('Reviewed change');
    expect(result.stdout).toContain('+export const value = 2;');
    expect(result.stdout).not.toContain('behavioralContract');
  });

  it('cancels an active harness and records an incomplete local status', async () => {
    const f = await fixture(); const bin = join(f.root, 'bin'); await mkdir(bin);
    const marker = join(f.root, 'harness-pid');
    await writeFile(join(bin, 'pi'), `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker + '.tmp')}, String(process.pid)); fs.renameSync(${JSON.stringify(marker + '.tmp')}, ${JSON.stringify(marker)}); setInterval(() => {}, 1000);\n`);
    await chmod(join(bin, 'pi'), 0o755);
    const controller = new AbortController();
    const watcher = watch(f.root, (_event, filename) => { if (filename === 'harness-pid') controller.abort(); });
    const output = join(f.root, 'cancelled-output');
    try {
      const code = await main(['review', '--harness', 'pi', '--indexing', 'disabled', '--provider', 'mock', '--endpoint', 'http://127.0.0.1:1/v1', '--model', 'fixture', '--auth', 'none',
        '--base', f.base, '--head', f.head, '--output', output], { ...f.env, PATH: bin + delimiter + process.env.PATH },
        { cwd: f.repository, signal: controller.signal, stdout: () => {}, stderr: () => {} });
      expect(code).toBe(130);
      expect(JSON.parse(await readFile(join(output, 'status.json'), 'utf8')).status).toBe('cancelled');
      const pid = Number(await readFile(marker, 'utf8'));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { watcher.close(); }
  });

  it('rejects intent-to-add and preserves executable mode changes and copies', async () => {
    const f = await fixture(); await writeFile(join(f.repository, 'copy.ts'), 'export const value = 2;\n');
    f.git('add', '-N', 'copy.ts');
    const intent = await f.run(); expect(intent.code).toBe(1); expect(intent.stderr).toContain('intent-to-add');
    f.git('add', 'copy.ts'); f.git('update-index', '--chmod=+x', 'example.ts');
    const result = await f.run(['--worktree', 'staged']); expect(result.code, result.stderr).toBe(0);
    const files = (await manifest(result.output)).files;
    expect(files.some((item: { newPath: string; status: string }) => item.newPath === 'copy.ts' && item.status === 'A')).toBe(true);
    expect(await readFile(join(result.output, 'bundle/diffs/000002.diff'), 'utf8')).toContain('new mode 100755');
  });

  it.each(['index', 'HEAD'])('rejects concurrent %s mutation', async (state) => {
    const f = await fixture(); await writeFile(join(f.repository, 'example.ts'), 'changed\n');
    const options = await parseLocalOptions(['--harness', 'echo'], f.env, f.repository);
    const output = join(f.root, 'capture'); await mkdir(output);
    const { GitCommand } = await import('../src/local/process.ts');
    const original = GitCommand.prototype.run;
    let mutated = false;
    vi.spyOn(GitCommand.prototype, 'run').mockImplementation(async function (this: InstanceType<typeof GitCommand>, args, input, env) {
      const value = await original.call(this, args, input, env);
      if (args[0] === 'hash-object' && !mutated) {
        mutated = true;
        if (state === 'index') f.git('update-index', '--chmod=+x', 'example.ts');
        else f.git('update-ref', 'HEAD', f.base);
      }
      return value;
    });
    await expect(new GitRevisionSource(options, f.env, output).capture(new AbortController().signal)).rejects.toThrow('index or HEAD changed');
  });

  it('rejects repository-local executable lookup even when invoked from a subdirectory', async () => {
    const f = await fixture(); const bin = join(f.repository, 'tools'); const sub = join(f.repository, 'sub');
    await mkdir(bin); await mkdir(sub);
    const marker = join(f.root, 'evil-git-ran');
    await writeFile(join(bin, 'git'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\n`);
    await chmod(join(bin, 'git'), 0o755);
    const options = await parseLocalOptions(['--harness', 'echo'], { ...f.env, PATH: bin + delimiter + process.env.PATH }, sub);
    expect(options.repository).toBe(f.repository);
    expect(await readFile(marker).catch(() => null)).toBeNull();
  });

  it('does not create default output through a repository path or symlink', async () => {
    const f = await fixture();
    const state = join(f.root, 'state-link'); await symlink(f.repository, state, process.platform === 'win32' ? 'junction' : 'dir');
    const code = await main(['review', '--harness', 'echo'], { ...f.env, XDG_STATE_HOME: state },
      { cwd: f.repository, stdout: () => {}, stderr: () => {} });
    expect(code).toBe(1);
    expect(await readFile(join(f.repository, 'redline/reviews/status.json')).catch(() => null)).toBeNull();
    const { lstat } = await import('node:fs/promises');
    expect(await lstat(join(f.repository, 'redline')).catch(() => null)).toBeNull();
  });

  it('handles cancellation without creating artifacts and strips terminal controls', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    const code = await main(['review', '--harness', 'echo'], f.env, { cwd: f.repository, signal: controller.signal, stdout: () => {}, stderr: () => {} });
    expect(code).toBe(130); expect(terminalText('\u001b[2Jsecret', 'secret')).toBe('?[2J[redacted]');
  });
});
