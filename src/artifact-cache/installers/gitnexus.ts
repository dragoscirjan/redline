import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { reviewToolDescriptorDigest } from '../contracts.js';
import { REVIEW_TOOL_DESCRIPTOR_VERSION, type ReviewToolDescriptor, type ToolInstaller } from '../types.js';
import { createInstalledToolManifest } from '../tool-tree.js';
import {
  assertFileContentDigest,
  FetchToolDownloader,
  nodeToolCommandRunner,
  type ToolCommandRunner,
  type ToolDownloader,
} from '../tool-transport.js';
import {
  assertIndexerDescriptor,
  diagnostic,
  failedInstallation,
  toolEnvironment,
  validateInstalledTool,
} from './common.js';
import type {
  ToolInstallationResult,
  ToolInstallRequest,
  ToolPlatform,
  ToolValidationRequest,
  ToolValidationResult,
} from '../types.js';

export const GITNEXUS_VERSION = '1.6.12';
const GITNEXUS_ARCHIVE_URL = `https://registry.npmjs.org/gitnexus/-/gitnexus-${GITNEXUS_VERSION}.tgz`;
const GITNEXUS_ARCHIVE_DIGEST = 'sha512:5b3fbe84e5bbdd2925b939102c96d1213f3e216eb8f4a99fe2623ef7d671cdc420d8d978eec4a395f7bcf4d37fab4baeb464ef6d57976983074434b39c3b24e6' as const;
const GITNEXUS_LOCK_URL = `https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/v${GITNEXUS_VERSION}/gitnexus/package-lock.json`;
const GITNEXUS_LOCK_DIGEST = 'sha256:d97b46eeb3c1cbc4e81ab0b13d84ccd50991b08c4b5488300088c234cc894678' as const;
const GITNEXUS_EXECUTABLE = '.redline/health.mjs';
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;

export function currentToolPlatform(): ToolPlatform {
  return { operatingSystem: process.platform, architecture: process.arch };
}

function corePlatformPackage(platform: ToolPlatform): string {
  const key = `${platform.operatingSystem}-${platform.architecture}`;
  const supported = new Set([
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ]);
  if (!supported.has(key)) throw new Error(`GitNexus ${GITNEXUS_VERSION} has no pinned native package for ${key}`);
  return `@ladybugdb/core-${key}`;
}

function assertSupportedNodeRuntime(): void {
  const [majorText, minorText] = process.versions.node.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  const supported = (major === 22 && minor >= 18) || (major >= 24 && (major > 24 || minor >= 11));
  if (!supported) throw new Error(`GitNexus ${GITNEXUS_VERSION} does not support Node ${process.versions.node}`);
}

/** Exact GitNexus build approved for the current Redline acquisition recipe. */
export function createGitNexusDescriptor(platform: ToolPlatform = currentToolPlatform()): ReviewToolDescriptor {
  corePlatformPackage(platform);
  return {
    version: REVIEW_TOOL_DESCRIPTOR_VERSION,
    id: 'gitnexus',
    displayName: 'GitNexus',
    family: 'code-indexer',
    providerId: 'gitnexus',
    toolVersion: GITNEXUS_VERSION,
    distribution: {
      source: GITNEXUS_ARCHIVE_URL,
      digest: GITNEXUS_ARCHIVE_DIGEST,
    },
    license: {
      name: 'PolyForm Noncommercial License 1.0.0',
      spdx: 'PolyForm-Noncommercial-1.0.0',
      url: 'https://polyformproject.org/licenses/noncommercial/1.0.0/',
      redistribution: 'conditional',
      notice: 'Use and redistribution must satisfy the PolyForm Noncommercial License terms.',
    },
    installerRecipeVersion: 'npm-ci-locked-v1',
    platform,
    runtimes: [{
      name: 'node',
      version: process.versions.node,
      abi: process.versions.modules,
    }],
    grammars: [],
    features: [
      `dependency-lock-${GITNEXUS_LOCK_DIGEST}`,
      'embeddings-disabled',
      'graphology-community-detection',
      'lifecycle-scripts-disabled',
    ],
    healthProbe: {
      executable: GITNEXUS_EXECUTABLE,
      args: ['--version'],
      expectedExitCode: 0,
      expectedOutput: `GitNexus ${GITNEXUS_VERSION} native-ok`,
    },
  };
}

export interface GitNexusInstallerOptions {
  readonly runner?: ToolCommandRunner;
  readonly downloader?: ToolDownloader;
  readonly nodeExecutable: string;
  readonly npmExecutable: string;
  readonly tarExecutable: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Test and controlled-upgrade seams; production defaults to the pinned metadata above. */
  readonly expectedDescriptor?: ReviewToolDescriptor;
  readonly dependencyLockUrl?: string;
  readonly dependencyLockDigest?: `sha256:${string}`;
}

/** Installs the pinned npm archive into an isolated prefix and removes npm's symlink bin farm. */
export class GitNexusInstaller implements ToolInstaller {
  readonly id = 'gitnexus';
  readonly #runner: ToolCommandRunner;
  readonly #downloader: ToolDownloader;
  readonly #nodeExecutable: string;
  readonly #npmExecutable: string;
  readonly #tarExecutable: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #expectedDescriptorDigest: string;
  readonly #dependencyLockUrl: string;
  readonly #dependencyLockDigest: `sha256:${string}`;

  constructor(options: GitNexusInstallerOptions) {
    this.#runner = options.runner ?? nodeToolCommandRunner;
    this.#downloader = options.downloader ?? new FetchToolDownloader();
    for (const [name, path] of [
      ['node', options.nodeExecutable],
      ['npm', options.npmExecutable],
      ['tar', options.tarExecutable],
    ] as const) {
      if (!isAbsolute(path)) throw new Error(`${name} executable path must be absolute`);
    }
    this.#nodeExecutable = options.nodeExecutable;
    this.#npmExecutable = options.npmExecutable;
    this.#tarExecutable = options.tarExecutable;
    this.#environment = { ...options.environment };
    this.#expectedDescriptorDigest = reviewToolDescriptorDigest(
      options.expectedDescriptor ?? createGitNexusDescriptor(),
    );
    this.#dependencyLockUrl = options.dependencyLockUrl ?? GITNEXUS_LOCK_URL;
    this.#dependencyLockDigest = options.dependencyLockDigest ?? GITNEXUS_LOCK_DIGEST;
    const expected = options.expectedDescriptor ?? createGitNexusDescriptor();
    if (!expected.features.includes(`dependency-lock-${this.#dependencyLockDigest}`)) {
      throw new Error('GitNexus descriptor does not bind the selected dependency lock digest');
    }
  }

  async install(request: ToolInstallRequest): Promise<ToolInstallationResult> {
    const startedAt = performance.now();
    const deadline = startedAt + request.timeoutMs;
    const remaining = (): number => Math.max(1, Math.floor(deadline - performance.now()));
    let temporaryDirectory: string | undefined;
    let createdDestination = false;
    let completed = false;
    try {
      const descriptor = assertIndexerDescriptor(request.descriptor, this.id);
      if (reviewToolDescriptorDigest(descriptor) !== this.#expectedDescriptorDigest) {
        throw new Error('GitNexus descriptor is not the pinned installer descriptor');
      }
      if (
        descriptor.platform.operatingSystem !== process.platform
        || descriptor.platform.architecture !== process.arch
      ) throw new Error('GitNexus descriptor does not match the current host platform');
      assertSupportedNodeRuntime();
      if (descriptor.distribution.digest === undefined) {
        throw new Error('GitNexus installation requires an immutable archive digest');
      }
      await mkdir(request.workDirectory, { recursive: true, mode: 0o755 });
      await chmod(request.workDirectory, 0o755);
      temporaryDirectory = await mkdtemp(join(request.workDirectory, '.gitnexus-install-'));
      const archive = join(temporaryDirectory, `gitnexus-${descriptor.toolVersion}.tgz`);
      await this.#downloader.download({
        url: descriptor.distribution.source,
        destination: archive,
        timeoutMs: remaining(),
        maximumBytes: MAX_ARCHIVE_BYTES,
      });
      await assertFileContentDigest(archive, descriptor.distribution.digest);
      await mkdir(request.destinationDirectory, { mode: 0o755 });
      createdDestination = true;
      const extracted = await this.#runner.run({
        command: this.#tarExecutable,
        args: ['-xzf', archive, '--strip-components=1', '-C', request.destinationDirectory],
        cwd: temporaryDirectory,
        env: toolEnvironment(temporaryDirectory, this.#environment),
        timeoutMs: remaining(),
      });
      if (extracted.timedOut) return failedInstallation(startedAt, 'gitnexus-extract-timed-out', 'archive extraction timed out', 'timed-out');
      if (extracted.code === null) {
        return failedInstallation(startedAt, 'gitnexus-extractor-unavailable', extracted.error ?? 'tar is unavailable', 'unavailable');
      }
      if (extracted.code !== 0) {
        return failedInstallation(startedAt, 'gitnexus-extract-failed', extracted.stderr || extracted.stdout || `tar exited ${extracted.code}`);
      }
      const lockfile = join(request.destinationDirectory, 'package-lock.json');
      await this.#downloader.download({
        url: this.#dependencyLockUrl,
        destination: lockfile,
        timeoutMs: remaining(),
        maximumBytes: MAX_LOCK_BYTES,
      });
      await assertFileContentDigest(lockfile, this.#dependencyLockDigest);
      await chmod(lockfile, 0o644);
      const installed = await this.#runner.run({
        command: this.#npmExecutable,
        args: ['ci', '--ignore-scripts', '--no-bin-links', '--omit=dev', '--no-audit', '--no-fund'],
        cwd: request.destinationDirectory,
        env: toolEnvironment(temporaryDirectory, this.#environment),
        timeoutMs: remaining(),
      });
      if (installed.timedOut) return failedInstallation(startedAt, 'gitnexus-install-timed-out', 'npm ci timed out', 'timed-out');
      if (installed.code === null) {
        return failedInstallation(startedAt, 'gitnexus-installer-unavailable', installed.error ?? 'npm is unavailable', 'unavailable');
      }
      if (installed.code !== 0) {
        return failedInstallation(startedAt, 'gitnexus-install-failed', installed.stderr || installed.stdout || `npm exited ${installed.code}`);
      }
      const nodeModules = join(request.destinationDirectory, 'node_modules');
      const nativePackage = corePlatformPackage(descriptor.platform);
      await copyFile(
        join(nodeModules, ...nativePackage.split('/'), 'lbugjs.node'),
        join(nodeModules, '@ladybugdb', 'core', 'lbugjs.node'),
      );
      await rm(join(nodeModules, '@huggingface', 'transformers'), { force: true, recursive: true });
      await rm(join(nodeModules, 'onnxruntime-node'), { force: true, recursive: true });
      const healthDirectory = join(request.destinationDirectory, '.redline');
      await mkdir(healthDirectory, { mode: 0o755 });
      const healthScript = [
        "await import('@ladybugdb/core');",
        "await import('tree-sitter');",
        "await import('tree-sitter-javascript');",
        `console.log('GitNexus ${GITNEXUS_VERSION} native-ok');`,
        '',
      ].join('\n');
      await writeFile(join(healthDirectory, 'health.mjs'), healthScript, { mode: 0o755 });
      const manifest = await createInstalledToolManifest(
        descriptor,
        request.destinationDirectory,
        [descriptor.healthProbe.executable],
      );
      completed = true;
      return {
        status: 'installed',
        manifest,
        diagnostics: extracted.stdoutTruncated || installed.stdoutTruncated
          ? [diagnostic('warning', 'gitnexus-install-output-truncated', 'acquisition output exceeded the diagnostic limit')]
          : [],
        durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      return failedInstallation(startedAt, 'gitnexus-install-failed', error);
    } finally {
      if (createdDestination && !completed) {
        try {
          await rm(request.destinationDirectory, { force: true, recursive: true });
        } catch {
          // The manager repeats cleanup before reporting acquisition failure.
        }
      }
      if (temporaryDirectory !== undefined) {
        try {
          await rm(temporaryDirectory, { force: true, recursive: true });
        } catch {
          // Work directories are caller-owned and later retention may reclaim this bounded temporary tree.
        }
      }
    }
  }

  async validate(request: ToolValidationRequest): Promise<ToolValidationResult> {
    try {
      const descriptor = assertIndexerDescriptor(request.descriptor, this.id);
      if (reviewToolDescriptorDigest(descriptor) !== this.#expectedDescriptorDigest) {
        throw new Error('GitNexus descriptor is not the pinned installer descriptor');
      }
    } catch (error) {
      return {
        status: 'invalid',
        diagnostics: [diagnostic('warning', 'gitnexus-descriptor-invalid', error instanceof Error ? error.message : String(error))],
        durationMs: 0,
      };
    }
    return validateInstalledTool(this.#runner, request, {
      environment: this.#environment,
      runtimeExecutable: this.#nodeExecutable,
    });
  }
}
