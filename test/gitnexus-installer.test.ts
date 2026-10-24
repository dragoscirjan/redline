import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FetchGitNexusDownloader,
  GITNEXUS_ARCHIVE,
  GITNEXUS_DEPENDENCY_LOCK,
  GITNEXUS_LICENSE,
  GITNEXUS_VERSION,
  installGitNexus,
  type GitNexusCommandRequest,
  type GitNexusCommandRunner,
  type GitNexusDownloadRequest,
  type GitNexusDownloader,
  type GitNexusInstallationSources,
} from '../src/code-index/gitnexus-installer.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function digest(algorithm: 'sha256' | 'sha512', content: string): string {
  return `${algorithm}:${createHash(algorithm).update(content).digest('hex')}`;
}

class FixtureDownloader implements GitNexusDownloader {
  readonly requests: GitNexusDownloadRequest[] = [];
  readonly #content: string | ((url: string) => string);

  constructor(content: string | ((url: string) => string)) {
    this.#content = content;
  }

  async download(request: GitNexusDownloadRequest): Promise<void> {
    this.requests.push(request);
    const selected = typeof this.#content === 'string' ? this.#content : this.#content(request.url);
    await writeFile(request.destination, selected, { mode: 0o600 });
  }
}

class FixtureRunner implements GitNexusCommandRunner {
  readonly requests: GitNexusCommandRequest[] = [];
  healthOutput: string | undefined;

  async run(request: GitNexusCommandRequest) {
    this.requests.push(request);
    if (request.command === '/fixture/tar') {
      const destination = request.args[request.args.indexOf('-C') + 1];
      if (destination === undefined) throw new Error('missing extraction destination');
      const cliDirectory = join(destination, 'dist', 'cli');
      await mkdir(cliDirectory, { recursive: true });
      await writeFile(join(cliDirectory, 'index.js'), '#!/usr/bin/env node\n');
      await chmod(join(cliDirectory, 'index.js'), 0o755);
      await writeFile(join(destination, 'package.json'), '{"name":"gitnexus"}\n');
      return {
        code: 0,
        timedOut: false,
        stdout: 'extracted',
        stderr: '',
        stdoutTruncated: false,
        durationMs: 1,
      };
    }
    if (request.command === '/fixture/npm') {
      const nodeModules = join(request.cwd, 'node_modules');
      const coreDirectory = join(nodeModules, '@ladybugdb', 'core');
      const nativeDirectory = join(nodeModules, `@ladybugdb/core-${process.platform}-${process.arch}`);
      await mkdir(coreDirectory, { recursive: true });
      await mkdir(nativeDirectory, { recursive: true });
      await writeFile(join(nativeDirectory, 'lbugjs.node'), 'native binding');
      return {
        code: 0,
        timedOut: false,
        stdout: 'installed',
        stderr: '',
        stdoutTruncated: false,
        durationMs: 1,
      };
    }
    return {
      code: 0,
      timedOut: false,
      stdout: this.healthOutput ?? `GitNexus ${GITNEXUS_VERSION} native-ok`,
      stderr: '',
      stdoutTruncated: false,
      durationMs: 1,
    };
  }
}

function fixtureSources(archive: string, lockfile: string): GitNexusInstallationSources {
  return {
    archive: {
      url: 'https://example.invalid/gitnexus.tgz',
      digest: digest('sha512', archive) as `sha512:${string}`,
    },
    dependencyLock: {
      url: 'https://example.invalid/package-lock.json',
      digest: digest('sha256', lockfile) as `sha256:${string}`,
    },
  };
}

function installationOptions(
  workspace: string,
  sources: GitNexusInstallationSources,
  downloader: GitNexusDownloader,
  runner: GitNexusCommandRunner,
) {
  return {
    destinationDirectory: join(workspace, 'installed'),
    workDirectory: join(workspace, 'work'),
    nodeExecutable: '/fixture/node',
    npmExecutable: '/fixture/npm',
    tarExecutable: '/fixture/tar',
    environment: { PATH: '/fixture' },
    timeoutMs: 5_000,
    sources,
    downloader,
    runner,
  } as const;
}

describe('FetchGitNexusDownloader', () => {
  it('never removes a destination that already exists', async () => {
    const workspace = await temporaryDirectory('redline-downloader-existing-');
    const destination = join(workspace, 'existing');
    await writeFile(destination, 'keep');
    await expect(new FetchGitNexusDownloader().download({
      url: 'https://example.invalid/tool',
      destination,
      timeoutMs: 1_000,
      maximumBytes: 1_024,
    })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf8')).toBe('keep');
  });
});

describe('installGitNexus', () => {
  it('retains the approved version, archive, lock, and license pins', () => {
    expect(GITNEXUS_VERSION).toBe('1.6.12');
    expect(GITNEXUS_ARCHIVE.url).toBe('https://registry.npmjs.org/gitnexus/-/gitnexus-1.6.12.tgz');
    expect(GITNEXUS_ARCHIVE.digest).toMatch(/^sha512:[0-9a-f]{128}$/u);
    expect(GITNEXUS_DEPENDENCY_LOCK.url).toContain('/v1.6.12/gitnexus/package-lock.json');
    expect(GITNEXUS_DEPENDENCY_LOCK.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(GITNEXUS_LICENSE.name).toBe('PolyForm Noncommercial License 1.0.0');
  });

  it('verifies both downloads, disables lifecycle scripts, and validates the installed tree', async () => {
    const workspace = await temporaryDirectory('redline-gitnexus-installer-');
    const archive = 'fixture gitnexus archive';
    const lockfile = 'fixture gitnexus lock';
    const sources = fixtureSources(archive, lockfile);
    const downloader = new FixtureDownloader((url) => url.endsWith('package-lock.json') ? lockfile : archive);
    const runner = new FixtureRunner();

    const executable = await installGitNexus(installationOptions(workspace, sources, downloader, runner));

    expect(executable).toBe(join(workspace, 'installed', 'dist', 'cli', 'index.js'));
    expect(downloader.requests.map((request) => request.url)).toEqual([
      sources.archive.url,
      sources.dependencyLock.url,
    ]);
    expect(runner.requests.map((request) => request.command)).toEqual([
      '/fixture/tar',
      '/fixture/npm',
      '/fixture/node',
    ]);
    expect(runner.requests[1]?.args).toContain('--ignore-scripts');
    expect(runner.requests[1]?.args).toContain('--no-bin-links');
    await expect(rm(join(workspace, 'installed', 'node_modules', '.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workspace, 'installed', 'node_modules', '@ladybugdb', 'core', 'lbugjs.node'), 'utf8'))
      .toBe('native binding');
  });

  it('rejects content that does not match the pinned archive digest and removes the partial tree', async () => {
    const workspace = await temporaryDirectory('redline-gitnexus-digest-');
    const sources = fixtureSources('expected archive', 'fixture lock');
    const runner = new FixtureRunner();
    const options = installationOptions(workspace, sources, new FixtureDownloader('tampered'), runner);

    await expect(installGitNexus(options)).rejects.toThrow('does not match its pinned digest');
    expect(runner.requests).toHaveLength(0);
    await expect(readFile(options.destinationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an invalid native health result and removes the installed tree', async () => {
    const workspace = await temporaryDirectory('redline-gitnexus-health-');
    const archive = 'fixture archive';
    const lockfile = 'fixture lock';
    const sources = fixtureSources(archive, lockfile);
    const runner = new FixtureRunner();
    runner.healthOutput = `GitNexus ${GITNEXUS_VERSION} wrong`;
    const options = installationOptions(
      workspace,
      sources,
      new FixtureDownloader((url) => url.endsWith('package-lock.json') ? lockfile : archive),
      runner,
    );

    await expect(installGitNexus(options)).rejects.toThrow('health probe returned unexpected output');
    await expect(readFile(options.destinationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires trusted absolute executable paths', async () => {
    const workspace = await temporaryDirectory('redline-gitnexus-path-');
    const options = installationOptions(
      workspace,
      fixtureSources('archive', 'lock'),
      new FixtureDownloader('unused'),
      new FixtureRunner(),
    );

    await expect(installGitNexus({ ...options, nodeExecutable: 'node' }))
      .rejects.toThrow('node executable path must be absolute');
  });
});
