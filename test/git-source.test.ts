import { execaSync } from 'execa';
import { createHash } from 'node:crypto';
import { constants, watch } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRevisionSource } from '../src/revision-source/git.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function repository(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const root = await mkdtemp(join(tmpdir(), 'redline-capture-test-'));
  roots.push(root);
  const directory = join(root, 'repository');
  await mkdir(directory);
  const environment = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  const git = (...args: string[]): string => execaSync('git', [
    '-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', ...args,
  ], { env: environment, extendEnv: false, maxBuffer: 1024 * 1024 }).stdout;
  git('init', '--quiet', '--template=', `--object-format=${objectFormat}`);
  await writeFile(join(directory, 'example.ts'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(directory, 'example.ts'), 'export const value = 2;\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  return { root, directory, environment, git, base, head };
}

interface Manifest {
  readonly version: number;
  readonly base: string;
  readonly head: string;
  readonly files: readonly {
    readonly newPath: string | null;
    readonly oldPath: string | null;
    readonly reviewed: boolean;
    readonly binary: boolean;
    readonly diffFile: string;
    readonly baseFile: string | null;
    readonly exclusionReason: string | null;
  }[];
}

describe('Git revision capture', () => {
  it('keeps gitlink base entries inert without treating them as missing blob failures', async () => {
    const fixture = await repository();
    fixture.git('update-index', '--add', '--cacheinfo', '160000', fixture.head, 'submodule');
    fixture.git('commit', '--quiet', '-m', 'gitlink base');
    const base = fixture.git('rev-parse', 'HEAD');
    fixture.git('update-index', '--force-remove', 'submodule');
    fixture.git('commit', '--quiet', '-m', 'remove gitlink');
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base,
      target: { kind: 'revision', head: 'HEAD', comparison: 'direct' }, outputDirectory: join(fixture.root, 'capture'),
    }, fixture.environment).capture(new AbortController().signal);
    try {
      const manifest: Manifest = JSON.parse(await readFile(join(captured.reviewDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.files).toEqual([expect.objectContaining({ oldPath: 'submodule', newPath: null, baseFile: null })]);
    } finally { await captured.dispose(); }
  });

  it('rejects an oversized deleted-file manifest before creating per-file artifacts', async () => {
    const fixture = await repository();
    const blob = fixture.git('rev-parse', fixture.head + ':example.ts');
    const tree = (input: string): string => execaSync('git', ['-C', fixture.directory, 'mktree'], {
      input, env: fixture.environment, extendEnv: false, maxBuffer: 1024 * 1024,
    }).stdout;
    const records = Array.from({ length: 20_001 }, (_, index) => `100644 blob ${blob}\tf${String(index).padStart(5, '0')}.ts\n`).join('');
    const base = fixture.git('commit-tree', tree(records), '-m', 'large base tree');
    const head = fixture.git('commit-tree', tree(''), '-p', base, '-m', 'delete all files');
    const outputDirectory = join(fixture.root, 'capture');
    const controller = new AbortController();
    // Stop a broken implementation at its first public per-file artifact, not after 20,001 subprocesses.
    const observer = watch(fixture.root, { recursive: true }, (_event, filename) => {
      if (filename?.toString().endsWith(join('bundle', 'diffs', '000001.diff'))) controller.abort();
    });
    const operation = new GitRevisionSource({
      repository: fixture.directory, base,
      target: { kind: 'revision', head, comparison: 'direct' }, outputDirectory,
    }, fixture.environment).capture(controller.signal).then(async result => {
      await result.dispose(); return result;
    });
    try {
      await expect(operation).rejects.toThrow('file count limit');
      await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort(); observer.close();
      await operation.catch(() => undefined);
    }
  });

  it('rejects an oversized raw index even when its tracked-file listing is small', async () => {
    const fixture = await repository();
    const indexPath = join(fixture.directory, '.git/index');
    const original = await readFile(indexPath);
    const extension = Buffer.alloc(8 + 16 * 1024 * 1024);
    extension.write('TEST', 0, 'ascii');
    extension.writeUInt32BE(extension.length - 8, 4);
    const content = Buffer.concat([original.subarray(0, -20), extension]);
    const index = Buffer.concat([content, createHash('sha1').update(content).digest()]);
    await writeFile(indexPath, index);
    const outputDirectory = join(fixture.root, 'capture');
    const operation = new GitRevisionSource({
      repository: fixture.directory, base: fixture.head,
      target: { kind: 'worktree', mode: 'all', untracked: false }, outputDirectory,
    }, fixture.environment).capture(new AbortController().signal).then(async result => {
      await result.dispose(); return result;
    });
    await expect(operation).rejects.toThrow(/Git index.*byte limit/u);
    await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readFile(indexPath)).equals(index)).toBe(true);
  });

  it('fails when required base content exceeds bounds even if its text patch is small', async () => {
    const fixture = await repository();
    const body = 'same line\n'.repeat(1_700_000);
    await writeFile(join(fixture.directory, 'large.txt'), 'before\n' + body);
    fixture.git('add', '.'); fixture.git('commit', '--quiet', '-m', 'large base');
    const base = fixture.git('rev-parse', 'HEAD');
    await writeFile(join(fixture.directory, 'large.txt'), 'after\n' + body);
    fixture.git('add', '.'); fixture.git('commit', '--quiet', '-m', 'small patch');
    const outputDirectory = join(fixture.root, 'capture');
    const operation = new GitRevisionSource({
      repository: fixture.directory, base,
      target: { kind: 'revision', head: 'HEAD', comparison: 'direct' }, outputDirectory,
    }, fixture.environment).capture(new AbortController().signal).then(async result => {
      await result.dispose(); return result;
    });
    await expect(operation).rejects.toThrow('byte limit');
    await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('preserves repository path whitespace instead of selecting a sibling repository', async () => {
    const selected = await repository();
    const sibling = await repository();
    await writeFile(join(sibling.directory, 'example.ts'), 'wrong repository\n');
    sibling.git('add', '.'); sibling.git('commit', '--quiet', '-m', 'different sibling');
    const directory = selected.directory + ' ';
    await rename(selected.directory, directory);
    await rename(sibling.directory, selected.directory);
    const captured = await new GitRevisionSource({
      repository: directory, base: 'HEAD~1',
      target: { kind: 'revision', head: 'HEAD', comparison: 'direct' }, outputDirectory: join(selected.root, 'capture'),
    }, selected.environment).capture(new AbortController().signal);
    try {
      expect(captured.repositoryDirectory).toBe(await realpath(directory));
      expect(await readFile(join(captured.sourceDirectory, 'example.ts'), 'utf8')).toBe('export const value = 2;\n');
    } finally { await captured.dispose(); }
  });

  it.each(['staged', 'unstaged', 'all'] as const)('does not let captured attributes hide text changes in %s mode', async mode => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, '.gitattributes'), '*.ts -diff\n');
    await writeFile(join(fixture.directory, 'example.ts'), 'staged text\n');
    fixture.git('add', '.');
    await writeFile(join(fixture.directory, 'example.ts'), 'working text\n');
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base: fixture.head,
      target: { kind: 'worktree', mode, untracked: false }, outputDirectory: join(fixture.root, 'capture'),
    }, fixture.environment).capture(new AbortController().signal);
    try {
      const manifest: Manifest = JSON.parse(await readFile(join(captured.reviewDirectory, 'manifest.json'), 'utf8'));
      const file = manifest.files.find(entry => entry.newPath === 'example.ts');
      expect(file).toMatchObject({ binary: false, reviewed: true });
      if (file === undefined) throw new Error('Captured file is missing');
      expect(await readFile(join(captured.reviewDirectory, file.diffFile), 'utf8'))
        .toContain(mode === 'staged' ? '+staged text' : '+working text');
    } finally { await captured.dispose(); }
  });

  it.each(['sha1', 'sha256'] as const)('captures authoritative %s revisions without changing the repository', async objectFormat => {
    const fixture = await repository(objectFormat);
    const index = await readFile(join(fixture.directory, '.git/index'));
    const refs = fixture.git('show-ref');
    const outputDirectory = join(fixture.root, 'capture');
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base: fixture.base,
      target: { kind: 'revision', head: fixture.head, comparison: 'direct' }, outputDirectory,
    }, fixture.environment).capture(new AbortController().signal);
    try {
      const manifest: Manifest = JSON.parse(await readFile(join(captured.reviewDirectory, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ version: 2, base: fixture.base, head: fixture.head,
        files: [{ newPath: 'example.ts', reviewed: true, binary: false }] });
      expect(await readFile(join(captured.sourceDirectory, 'example.ts'), 'utf8')).toBe('export const value = 2;\n');
      expect(await readFile(join(captured.reviewDirectory, 'base-files/000001'), 'utf8')).toBe('export const value = 1;\n');
      expect(await readFile(join(captured.reviewDirectory, 'diffs/000001.diff'), 'utf8'))
        .toContain('+export const value = 2;');
      expect(await readFile(join(fixture.directory, '.git/index'))).toEqual(index);
      expect(fixture.git('show-ref')).toBe(refs);
      expect(fixture.git('status', '--porcelain')).toBe('');
    } finally { await captured.dispose(); }
  });

  it.each(['staged', 'unstaged', 'all'] as const)('captures exact %s contents without modifying the index or working tree', async mode => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, 'example.ts'), 'staged\n');
    fixture.git('add', '.');
    await writeFile(join(fixture.directory, 'example.ts'), 'unstaged\n');
    await writeFile(join(fixture.directory, 'private.txt'), 'excluded untracked content\n');
    const index = await readFile(join(fixture.directory, '.git/index'));
    const status = fixture.git('status', '--porcelain');
    const outputDirectory = join(fixture.root, 'capture');
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base: fixture.head,
      target: { kind: 'worktree', mode, untracked: false }, outputDirectory,
    }, fixture.environment).capture(new AbortController().signal);
    try {
      expect(await readFile(join(captured.sourceDirectory, 'example.ts'), 'utf8')).toBe(mode === 'staged' ? 'staged\n' : 'unstaged\n');
      expect(await readFile(join(captured.reviewDirectory, 'base-files/000001'), 'utf8'))
        .toBe(mode === 'unstaged' ? 'staged\n' : 'export const value = 2;\n');
      const metadata: { readonly indexDigest: string } = JSON.parse(await readFile(join(outputDirectory, 'capture.json'), 'utf8'));
      expect(metadata.indexDigest).toBe(createHash('sha256').update(index).digest('hex'));
      expect(captured.coverage?.excludedUntrackedFiles).toBe(mode === 'staged' ? 0 : 1);
      await expect(lstat(join(captured.sourceDirectory, 'private.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(fixture.directory, '.git/index'))).toEqual(index);
      expect(fixture.git('status', '--porcelain')).toBe(status);
      await writeFile(join(fixture.directory, 'example.ts'), 'later change\n');
      expect(await readFile(join(captured.sourceDirectory, 'example.ts'), 'utf8')).toBe(mode === 'staged' ? 'staged\n' : 'unstaged\n');
    } finally { await captured.dispose(); }
  });

  it('captures explicitly included untracked files and excludes binary, lock and generated files from review', async () => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, 'new.ts'), 'export const added = true;\n');
    await writeFile(join(fixture.directory, 'data.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(fixture.directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await mkdir(join(fixture.directory, 'dist'));
    await writeFile(join(fixture.directory, 'dist/output.js'), 'generated\n');
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base: fixture.head,
      target: { kind: 'worktree', mode: 'all', untracked: true }, outputDirectory: join(fixture.root, 'capture'),
    }, fixture.environment).capture(new AbortController().signal);
    try {
      const manifest: Manifest = JSON.parse(await readFile(join(captured.reviewDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ newPath: 'new.ts', reviewed: true }),
        expect.objectContaining({ newPath: 'data.bin', binary: true, reviewed: false }),
        expect.objectContaining({ newPath: 'pnpm-lock.yaml', reviewed: false, exclusionReason: 'lock file' }),
        expect.objectContaining({ newPath: 'dist/output.js', reviewed: false, exclusionReason: 'generated or vendored directory' }),
      ]));
      expect(await readFile(join(captured.sourceDirectory, 'new.ts'), 'utf8')).toBe('export const added = true;\n');
      expect(captured.coverage?.excludedUntrackedFiles).toBe(0);
    } finally { await captured.dispose(); }
  });

  it.skipIf(process.platform === 'win32')('captures renames and deletions while keeping symlinks inert', async () => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, 'removed.ts'), 'deleted\n');
    fixture.git('add', '.'); fixture.git('commit', '--quiet', '-m', 'add deletion fixture');
    const base = fixture.git('rev-parse', 'HEAD');
    await rename(join(fixture.directory, 'example.ts'), join(fixture.directory, 'renamed.ts'));
    await rm(join(fixture.directory, 'removed.ts'));
    const outside = join(fixture.root, 'outside.txt');
    await writeFile(outside, 'must not be copied through a link\n');
    await symlink(outside, join(fixture.directory, 'link'));
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base,
      target: { kind: 'worktree', mode: 'all', untracked: true }, outputDirectory: join(fixture.root, 'capture'),
    }, fixture.environment).capture(new AbortController().signal);
    try {
      const manifest: Manifest = JSON.parse(await readFile(join(captured.reviewDirectory, 'manifest.json'), 'utf8'));
      expect(manifest.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ oldPath: 'example.ts', newPath: 'renamed.ts' }),
        expect.objectContaining({ oldPath: 'removed.ts', newPath: null }),
      ]));
      expect(captured.coverage?.inertSymlinks).toBe(1);
      await expect(lstat(join(captured.sourceDirectory, 'link'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(outside, 'utf8')).toBe('must not be copied through a link\n');
    } finally { await captured.dispose(); }
  });

  it('honors pre-existing cancellation without writing capture artifacts', async () => {
    const fixture = await repository();
    const controller = new AbortController(); controller.abort();
    const outputDirectory = join(fixture.root, 'capture');
    await expect(new GitRevisionSource({
      repository: fixture.directory, base: fixture.base,
      target: { kind: 'revision', head: fixture.head, comparison: 'direct' }, outputDirectory,
    }, fixture.environment).capture(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an existing output directory without overwriting or adding artifacts', async () => {
    const fixture = await repository();
    const outputDirectory = join(fixture.root, 'capture');
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, 'capture.json'), 'preserve existing content\n');
    const capture = new GitRevisionSource({
      repository: fixture.directory, base: fixture.base,
      target: { kind: 'revision', head: fixture.head, comparison: 'direct' }, outputDirectory,
    }, fixture.environment).capture(new AbortController().signal).then(async result => {
      await result.dispose(); return result;
    });
    await expect(capture).rejects.toThrow('capture output');
    expect(await readFile(join(outputDirectory, 'capture.json'), 'utf8')).toBe('preserve existing content\n');
    expect(await readdir(outputDirectory)).toEqual(['capture.json']);
  });

  it.skipIf(process.platform === 'win32').each(['tools', '..tools'])('does not execute Git binaries in repository-local %s when selected through a subdirectory', async toolDirectory => {
    const fixture = await repository();
    const tools = join(fixture.directory, toolDirectory);
    const nested = join(fixture.directory, 'nested');
    await mkdir(tools); await mkdir(nested);
    const marker = join(fixture.root, 'untrusted-git-ran');
    await writeFile(join(tools, 'git'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nprocess.exit(99);\n`, { mode: 0o755 });
    const captured = await new GitRevisionSource({
      repository: nested, base: fixture.base,
      target: { kind: 'revision', head: fixture.head, comparison: 'direct' }, outputDirectory: join(fixture.root, 'capture'),
    }, { ...fixture.environment, PATH: tools + delimiter + fixture.environment.PATH }).capture(new AbortController().signal);
    try {
      await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(captured.sourceDirectory, 'example.ts'), 'utf8')).toBe('export const value = 2;\n');
    } finally { await captured.dispose(); }
  });

  it('uses the unique merge base when requested instead of the supplied branch tip', async () => {
    const fixture = await repository();
    fixture.git('checkout', '--quiet', '-b', 'other', fixture.base);
    await writeFile(join(fixture.directory, 'other.ts'), 'other branch\n');
    fixture.git('add', '.'); fixture.git('commit', '--quiet', '-m', 'other');
    const requestedBase = fixture.git('rev-parse', 'HEAD');
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base: requestedBase,
      target: { kind: 'revision', head: fixture.head, comparison: 'merge-base' }, outputDirectory: join(fixture.root, 'capture'),
    }, fixture.environment).capture(new AbortController().signal);
    try {
      const manifest: Manifest = JSON.parse(await readFile(join(captured.reviewDirectory, 'manifest.json'), 'utf8'));
      expect({ base: manifest.base, head: manifest.head }).toEqual({ base: fixture.base, head: fixture.head });
      expect(manifest.files.map(file => file.newPath)).toEqual(['example.ts']);
    } finally { await captured.dispose(); }
  });

  it('loads review eligibility from committed base, not contributor-controlled head content', async () => {
    const fixture = await repository();
    await mkdir(join(fixture.directory, '.redline'));
    const policy = join(fixture.directory, '.redline/review-eligibility.json');
    await writeFile(policy, JSON.stringify({ version: 1, include: [], exclude: [{ pattern: 'example.ts', reason: 'trusted exclusion' }] }));
    fixture.git('add', '.'); fixture.git('commit', '--quiet', '-m', 'trusted policy');
    const base = fixture.git('rev-parse', 'HEAD');
    await writeFile(policy, 'untrusted head does not define policy\n');
    await writeFile(join(fixture.directory, 'example.ts'), 'export const value = 3;\n');
    fixture.git('add', '.'); fixture.git('commit', '--quiet', '-m', 'untrusted changes');
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base,
      target: { kind: 'revision', head: 'HEAD', comparison: 'direct' }, outputDirectory: join(fixture.root, 'capture'),
    }, fixture.environment).capture(new AbortController().signal);
    try {
      const manifest: Manifest = JSON.parse(await readFile(join(captured.reviewDirectory, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ eligibility: { source: 'trusted-base' } });
      expect(manifest.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ newPath: 'example.ts', reviewed: false, exclusionReason: 'trusted exclusion' }),
        expect.objectContaining({ newPath: '.redline/review-eligibility.json', reviewed: true }),
      ]));
    } finally { await captured.dispose(); }
  });

  it('records omitted oversized source spans instead of presenting complete source coverage', async () => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, 'large.ts'), 'x'.repeat(128 * 1024 + 1));
    fixture.git('add', '.'); fixture.git('commit', '--quiet', '-m', 'large source');
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base: fixture.head,
      target: { kind: 'revision', head: 'HEAD', comparison: 'direct' }, outputDirectory: join(fixture.root, 'capture'),
    }, fixture.environment).capture(new AbortController().signal);
    try {
      expect(captured.coverage?.omittedSourceFiles).toBe(1);
      await expect(lstat(join(captured.sourceDirectory, 'large.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await captured.dispose(); }
  });

  it('fails bounded working-tree capture and removes artifacts created by that failed attempt', async () => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, 'large.ts'), Buffer.alloc(16 * 1024 * 1024 + 1, 120));
    const outputDirectory = join(fixture.root, 'capture');
    const index = await readFile(join(fixture.directory, '.git/index'));
    await expect(new GitRevisionSource({
      repository: fixture.directory, base: fixture.head,
      target: { kind: 'worktree', mode: 'all', untracked: true }, outputDirectory,
    }, fixture.environment).capture(new AbortController().signal)).rejects.toThrow('oversized');
    await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(fixture.directory, '.git/index'))).toEqual(index);
  });

  it.each(['capture', '..capture'])('rejects %s output inside the reviewed repository before writing artifacts', async name => {
    const fixture = await repository();
    const outputDirectory = join(fixture.directory, name);
    await expect(new GitRevisionSource({
      repository: fixture.directory, base: fixture.base,
      target: { kind: 'revision', head: fixture.head, comparison: 'direct' }, outputDirectory,
    }, fixture.environment).capture(new AbortController().signal).then(async result => {
      await result.dispose(); return result;
    })).rejects.toThrow('outside the reviewed repository');
    expect(fixture.git('status', '--porcelain')).toBe('');
  });

  it.skipIf(process.platform === 'win32')('cancels an active Git process and removes only its owned scratch and output', async () => {
    const fixture = await repository();
    const tools = join(fixture.root, 'tools'); await mkdir(tools);
    let hostGit: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      const candidate = join(directory, 'git');
      try { await access(candidate, constants.X_OK); hostGit = await realpath(candidate); break; }
      catch { /* Continue through the trusted test runner's PATH. */ }
    }
    if (hostGit === undefined) throw new Error('Git is required for capture integration tests');
    const marker = join(tools, 'ready.json');
    const script = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('ls-tree')) {
  fs.writeFileSync(${JSON.stringify(marker + '.tmp')}, JSON.stringify({ pid: process.pid, directory: process.cwd() }));
  fs.renameSync(${JSON.stringify(marker + '.tmp')}, ${JSON.stringify(marker)});
  setInterval(() => {}, 1000);
} else {
  const result = spawnSync(${JSON.stringify(hostGit)}, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`;
    await writeFile(join(tools, 'git'), script, { mode: 0o755 });
    interface Ready { readonly pid: number; readonly directory: string }
    let observer: ReturnType<typeof watch> | undefined;
    const ready = new Promise<Ready>((resolve, reject) => {
      observer = watch(tools, (_event, filename) => {
        if (filename?.toString() !== 'ready.json') return;
        void readFile(marker, 'utf8').then(raw => resolve(JSON.parse(raw))).catch(reject);
      });
      observer.on('error', reject);
    });
    const controller = new AbortController();
    const outputDirectory = join(fixture.root, 'capture');
    const operation = new GitRevisionSource({
      repository: fixture.directory, base: fixture.base,
      target: { kind: 'revision', head: fixture.head, comparison: 'direct' }, outputDirectory,
    }, { ...fixture.environment, PATH: tools }).capture(controller.signal);
    try {
      const processInfo = await Promise.race([ready, operation.then(async result => {
        await result.dispose(); throw new Error('Capture completed before the controlled Git process blocked');
      })]);
      controller.abort();
      await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
      expect(() => process.kill(processInfo.pid, 0)).toThrow();
      await expect(lstat(processInfo.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fixture.git('status', '--porcelain')).toBe('');
    } finally {
      controller.abort(); observer?.close();
      await operation.then(result => result.dispose(), () => undefined);
    }
  });

  it('rejects an untracked request for a staged-only snapshot instead of silently dropping it', async () => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, 'new.ts'), 'untracked\n');
    const outputDirectory = join(fixture.root, 'capture');
    const operation = new GitRevisionSource({
      repository: fixture.directory, base: fixture.head,
      target: { kind: 'worktree', mode: 'staged', untracked: true }, outputDirectory,
    }, fixture.environment).capture(new AbortController().signal).then(async result => {
      await result.dispose(); return result;
    });
    await expect(operation).rejects.toThrow('untracked');
    await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['sha1', 'sha256'] as const)('preserves %s shallow-history boundaries during capture', async objectFormat => {
    const fixture = await repository(objectFormat);
    await writeFile(join(fixture.directory, 'example.ts'), 'third commit\n');
    fixture.git('add', '.'); fixture.git('commit', '--quiet', '-m', 'third');
    const head = fixture.git('rev-parse', 'HEAD');
    const shallow = join(fixture.root, 'shallow');
    fixture.git('clone', '--quiet', '--depth', '2', pathToFileURL(fixture.directory).href, shallow);
    const boundary = await readFile(join(shallow, '.git/shallow'));
    const index = await readFile(join(shallow, '.git/index'));
    const captured = await new GitRevisionSource({
      repository: shallow, base: fixture.head,
      target: { kind: 'revision', head, comparison: 'merge-base' }, outputDirectory: join(fixture.root, 'capture'),
    }, fixture.environment).capture(new AbortController().signal);
    try {
      expect(await readFile(join(captured.sourceDirectory, 'example.ts'), 'utf8')).toBe('third commit\n');
      expect(await readFile(join(shallow, '.git/shallow'))).toEqual(boundary);
      expect(await readFile(join(shallow, '.git/index'))).toEqual(index);
    } finally { await captured.dispose(); }
  });

  it('does not execute repository hooks, filters, text converters, external diff or fsmonitor', async () => {
    const fixture = await repository();
    await writeFile(join(fixture.directory, '.gitattributes'), '*.ts diff=evil filter=evil\n');
    fixture.git('add', '.'); fixture.git('commit', '--quiet', '-m', 'attributes');
    const marker = join(fixture.root, 'repository-code-ran');
    const hook = join(fixture.root, 'hook.mjs');
    await writeFile(hook, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\n`);
    const command = `"${process.execPath}" "${hook}"`;
    for (const key of ['filter.evil.clean', 'filter.evil.smudge', 'diff.evil.command', 'diff.evil.textconv', 'diff.external', 'core.fsmonitor']) {
      fixture.git('config', key, command);
    }
    const hooks = join(fixture.root, 'hooks'); await mkdir(hooks);
    for (const name of ['pre-commit', 'post-checkout', 'reference-transaction']) {
      await writeFile(join(hooks, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`, { mode: 0o755 });
    }
    fixture.git('config', 'core.hooksPath', hooks);
    await writeFile(join(fixture.directory, 'example.ts'), 'working-tree change\n');
    const captured = await new GitRevisionSource({
      repository: fixture.directory, base: fixture.head,
      target: { kind: 'worktree', mode: 'all', untracked: false }, outputDirectory: join(fixture.root, 'capture'),
    }, fixture.environment).capture(new AbortController().signal);
    try {
      await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(captured.sourceDirectory, 'example.ts'), 'utf8')).toBe('working-tree change\n');
    } finally { await captured.dispose(); }
  });
});
