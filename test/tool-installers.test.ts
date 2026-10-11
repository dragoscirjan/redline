import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CGC_VERSION,
  CgcInstaller,
  createCgcDescriptor,
} from '../src/artifact-cache/installers/cgc.js';
import {
  GITNEXUS_VERSION,
  GitNexusInstaller,
  createGitNexusDescriptor,
} from '../src/artifact-cache/installers/gitnexus.js';
import { createCodeIndexerInstallerRegistry } from '../src/artifact-cache/installers/index.js';
import type { ReviewToolDescriptor } from '../src/artifact-cache/types.js';
import { FetchToolDownloader } from '../src/artifact-cache/tool-transport.js';
import type {
  ToolCommandRequest,
  ToolCommandRunner,
  ToolDownloadRequest,
  ToolDownloader,
} from '../src/artifact-cache/tool-transport.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function digest(algorithm: 'sha256' | 'sha512', content: string): `sha256:${string}` | `sha512:${string}` {
  return `${algorithm}:${createHash(algorithm).update(content).digest('hex')}`;
}

class FixtureDownloader implements ToolDownloader {
  readonly requests: ToolDownloadRequest[] = [];
  constructor(readonly content: string | ((url: string) => string)) {}

  async download(request: ToolDownloadRequest): Promise<void> {
    this.requests.push(request);
    const selected = typeof this.content === 'string' ? this.content : this.content(request.url);
    await writeFile(request.destination, selected, { mode: 0o600 });
  }
}

class FixtureRunner implements ToolCommandRunner {
  readonly requests: ToolCommandRequest[] = [];
  healthOutput: string | undefined;

  async run(request: ToolCommandRequest) {
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
      stdout: this.healthOutput
        ?? (request.command.endsWith('cgc')
          ? `CodeGraphContext ${CGC_VERSION}`
          : `GitNexus ${GITNEXUS_VERSION} native-ok`),
      stderr: '',
      stdoutTruncated: false,
      durationMs: 1,
    };
  }
}

function withFixtureDistribution(
  descriptor: ReviewToolDescriptor,
  algorithm: 'sha256' | 'sha512',
  content: string,
): ReviewToolDescriptor {
  return {
    ...descriptor,
    distribution: {
      source: 'https://example.invalid/pinned-tool',
      digest: digest(algorithm, content),
    },
  };
}

describe('FetchToolDownloader', () => {
  it('never removes a destination that already exists', async () => {
    const workspace = await temporaryDirectory('redline-downloader-existing-');
    const destination = join(workspace, 'existing');
    await writeFile(destination, 'keep');
    await expect(new FetchToolDownloader().download({
      url: 'https://example.invalid/tool',
      destination,
      timeoutMs: 1_000,
      maximumBytes: 1_024,
    })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf8')).toBe('keep');
  });
});

describe('code-indexer tool descriptors', () => {
  it('pins exact versions, immutable distributions, runtimes, and licensing', () => {
    const gitNexus = createGitNexusDescriptor();
    expect(gitNexus.toolVersion).toBe('1.6.12');
    expect(gitNexus.distribution.source).toBe('https://registry.npmjs.org/gitnexus/-/gitnexus-1.6.12.tgz');
    expect(gitNexus.distribution.digest).toMatch(/^sha512:[0-9a-f]{128}$/u);
    expect(gitNexus.runtimes).toEqual([{
      name: 'node',
      version: process.versions.node,
      abi: process.versions.modules,
    }]);
    expect(gitNexus.license.redistribution).toBe('conditional');

    const cgc = createCgcDescriptor({ operatingSystem: 'linux', architecture: 'x64' });
    expect(cgc.toolVersion).toBe('0.5.7');
    expect(cgc.distribution.source).toContain('/v0.5.7/cgc-linux-x86_64');
    expect(cgc.distribution.digest).toBe('sha256:9b62140c77e88d153de24abfaebe1977f320511b170bf9aea6087106601d0e5f');
    expect(cgc.license.redistribution).toBe('allowed');
    expect(() => createCgcDescriptor({ operatingSystem: 'linux', architecture: 'mips' })).toThrow('no pinned binary');
    expect(createCodeIndexerInstallerRegistry({
      nodeExecutable: '/trusted/node',
      npmExecutable: '/trusted/npm',
      tarExecutable: '/trusted/tar',
      environment: { PATH: '/trusted' },
    }).ids()).toEqual(['cgc', 'gitnexus']);
    expect(() => new GitNexusInstaller({
      nodeExecutable: 'node',
      npmExecutable: '/trusted/npm',
      tarExecutable: '/trusted/tar',
      environment: {},
    })).toThrow('node executable path must be absolute');
  });
});

describe('GitNexusInstaller', () => {
  it('verifies the archive, uses a pinned dependency lock, and validates the resulting tree', async () => {
    const workspace = await temporaryDirectory('redline-gitnexus-installer-');
    const archive = 'fixture gitnexus archive';
    const lockfile = 'fixture gitnexus lock';
    const lockDigest = digest('sha256', lockfile) as `sha256:${string}`;
    const baseDescriptor = withFixtureDistribution(createGitNexusDescriptor(), 'sha512', archive);
    const selectedDescriptor = {
      ...baseDescriptor,
      features: [
        `dependency-lock-${lockDigest}`,
        ...baseDescriptor.features.filter((feature) => !feature.startsWith('dependency-lock-')),
      ].sort(),
    };
    const downloader = new FixtureDownloader((url) => url.endsWith('package-lock.json') ? lockfile : archive);
    const runner = new FixtureRunner();
    const installer = new GitNexusInstaller({
      downloader,
      runner,
      nodeExecutable: '/fixture/node',
      npmExecutable: '/fixture/npm',
      tarExecutable: '/fixture/tar',
      environment: { PATH: '/fixture' },
      expectedDescriptor: selectedDescriptor,
      dependencyLockUrl: 'https://example.invalid/package-lock.json',
      dependencyLockDigest: lockDigest,
    });
    const installationDirectory = join(workspace, 'installed');
    const result = await installer.install({
      descriptor: selectedDescriptor,
      destinationDirectory: installationDirectory,
      workDirectory: join(workspace, 'work'),
      timeoutMs: 5_000,
    });
    if (result.status !== 'installed') throw new Error(JSON.stringify(result.diagnostics));
    expect(downloader.requests[0]?.url).toBe(selectedDescriptor.distribution.source);
    expect(runner.requests.map((request) => request.command)).toEqual(['/fixture/tar', '/fixture/npm']);
    expect(runner.requests[1]?.args).toContain('--ignore-scripts');
    expect(runner.requests[1]?.args).toContain('--no-bin-links');
    await expect(rm(join(installationDirectory, 'node_modules', '.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    const validation = await installer.validate({
      descriptor: selectedDescriptor,
      installationDirectory,
      manifest: result.manifest,
      timeoutMs: 5_000,
    });
    expect(validation.status).toBe('valid');

    runner.healthOutput = `${GITNEXUS_VERSION}0`;
    const wrongVersion = await installer.validate({
      descriptor: selectedDescriptor,
      installationDirectory,
      manifest: result.manifest,
      timeoutMs: 5_000,
    });
    expect(wrongVersion.status).toBe('invalid');
  });

  it('rejects content that does not match the pinned archive digest', async () => {
    const workspace = await temporaryDirectory('redline-gitnexus-digest-');
    const lockfile = 'fixture gitnexus lock';
    const lockDigest = digest('sha256', lockfile) as `sha256:${string}`;
    const baseDescriptor = withFixtureDistribution(createGitNexusDescriptor(), 'sha512', 'expected');
    const selectedDescriptor = {
      ...baseDescriptor,
      features: [
        `dependency-lock-${lockDigest}`,
        ...baseDescriptor.features.filter((feature) => !feature.startsWith('dependency-lock-')),
      ].sort(),
    };
    const runner = new FixtureRunner();
    const installer = new GitNexusInstaller({
      downloader: new FixtureDownloader('tampered'),
      runner,
      nodeExecutable: '/fixture/node',
      npmExecutable: '/fixture/npm',
      tarExecutable: '/fixture/tar',
      environment: { PATH: '/fixture' },
      expectedDescriptor: selectedDescriptor,
      dependencyLockUrl: 'https://example.invalid/package-lock.json',
      dependencyLockDigest: lockDigest,
    });
    const result = await installer.install({
      descriptor: selectedDescriptor,
      destinationDirectory: join(workspace, 'installed'),
      workDirectory: join(workspace, 'work'),
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('failed');
    expect(result.diagnostics[0]?.message).toContain('digest does not match');
    expect(runner.requests).toHaveLength(0);
  });
});

const cgcHostSupported = ['linux/x64', 'darwin/arm64'].includes(`${process.platform}/${process.arch}`);

describe('CgcInstaller', () => {
  it.skipIf(!cgcHostSupported)('verifies and installs a pinned standalone binary, then runs its health probe', async () => {
    const workspace = await temporaryDirectory('redline-cgc-installer-');
    const binary = 'fixture cgc binary';
    const selectedDescriptor = withFixtureDistribution(createCgcDescriptor(), 'sha256', binary);
    const downloader = new FixtureDownloader(binary);
    const runner = new FixtureRunner();
    const installer = new CgcInstaller({
      downloader,
      runner,
      environment: {},
      expectedDescriptor: selectedDescriptor,
    });
    const installationDirectory = join(workspace, 'installed');
    const result = await installer.install({
      descriptor: selectedDescriptor,
      destinationDirectory: installationDirectory,
      workDirectory: join(workspace, 'work'),
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('installed');
    if (result.status !== 'installed') throw new Error('installation failed');
    const validation = await installer.validate({
      descriptor: selectedDescriptor,
      installationDirectory,
      manifest: result.manifest,
      timeoutMs: 5_000,
    });
    expect(validation.status).toBe('valid');
    expect(runner.requests[0]?.command).toBe(join(installationDirectory, 'bin', 'cgc'));
    expect(runner.requests[0]?.args).toEqual(['version']);

    await chmod(join(installationDirectory, 'bin', 'cgc'), 0o644);
    const invalid = await installer.validate({
      descriptor: selectedDescriptor,
      installationDirectory,
      manifest: result.manifest,
      timeoutMs: 5_000,
    });
    expect(invalid.status).toBe('invalid');
  });
});
