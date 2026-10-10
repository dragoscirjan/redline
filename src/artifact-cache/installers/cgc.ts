import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewToolDescriptorDigest } from '../contracts.js';
import { createInstalledToolManifest } from '../tool-tree.js';
import {
  assertFileContentDigest,
  FetchToolDownloader,
  nodeToolCommandRunner,
  type ToolCommandRunner,
  type ToolDownloader,
} from '../tool-transport.js';
import {
  REVIEW_TOOL_DESCRIPTOR_VERSION,
  type ReviewToolDescriptor,
  type ToolInstaller,
  type ToolInstallationResult,
  type ToolInstallRequest,
  type ToolPlatform,
  type ToolValidationRequest,
  type ToolValidationResult,
} from '../types.js';
import {
  assertIndexerDescriptor,
  diagnostic,
  failedInstallation,
  validateInstalledTool,
} from './common.js';

export const CGC_VERSION = '0.5.7';
const MAX_BINARY_BYTES = 128 * 1024 * 1024;

const CGC_ASSETS = {
  'linux/x64': {
    name: 'cgc-linux-x86_64',
    digest: 'sha256:9b62140c77e88d153de24abfaebe1977f320511b170bf9aea6087106601d0e5f',
    executable: 'bin/cgc',
  },
  'darwin/arm64': {
    name: 'cgc-macos-arm64',
    digest: 'sha256:665b3d5ca72a0351107cd160c769b6bcb2f6949b5c35f8295493e476fd942d22',
    executable: 'bin/cgc',
  },
  'win32/x64': {
    name: 'cgc-windows.exe',
    digest: 'sha256:728a7933f14443910af8d84a43ade96edf117e6bd4134c4fe03f63925e3de3c6',
    executable: 'bin/cgc.exe',
  },
} as const;

type CgcPlatform = keyof typeof CGC_ASSETS;

function assetFor(platform: ToolPlatform): (typeof CGC_ASSETS)[CgcPlatform] {
  const key = `${platform.operatingSystem}/${platform.architecture}` as CgcPlatform;
  const asset = CGC_ASSETS[key];
  if (asset === undefined) throw new Error(`CGC ${CGC_VERSION} has no pinned binary for ${key}`);
  return asset;
}

/** Exact standalone CGC build approved for this host platform. */
export function createCgcDescriptor(
  platform: ToolPlatform = { operatingSystem: process.platform, architecture: process.arch },
): ReviewToolDescriptor {
  const asset = assetFor(platform);
  return {
    version: REVIEW_TOOL_DESCRIPTOR_VERSION,
    id: 'cgc',
    displayName: 'CodeGraphContext',
    family: 'code-indexer',
    providerId: 'cgc',
    toolVersion: CGC_VERSION,
    distribution: {
      source: `https://github.com/CodeGraphContext/CodeGraphContext/releases/download/v${CGC_VERSION}/${asset.name}`,
      digest: asset.digest,
    },
    license: {
      name: 'MIT License',
      spdx: 'MIT',
      url: 'https://github.com/CodeGraphContext/CodeGraphContext/blob/v0.5.7/LICENSE',
      redistribution: 'allowed',
    },
    installerRecipeVersion: 'standalone-release-v1',
    platform,
    runtimes: [],
    grammars: [],
    features: ['standalone-binary'],
    healthProbe: {
      executable: asset.executable,
      args: ['version'],
      expectedExitCode: 0,
      expectedOutput: `CodeGraphContext ${CGC_VERSION}`,
    },
  };
}

export interface CgcInstallerOptions {
  readonly runner?: ToolCommandRunner;
  readonly downloader?: ToolDownloader;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Test and controlled-upgrade seam; production defaults to the pinned descriptor above. */
  readonly expectedDescriptor?: ReviewToolDescriptor;
}

/** Installs a pinned standalone CGC release after verifying GitHub's published SHA-256 digest. */
export class CgcInstaller implements ToolInstaller {
  readonly id = 'cgc';
  readonly #runner: ToolCommandRunner;
  readonly #downloader: ToolDownloader;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #expectedDescriptorDigest: string;

  constructor(options: CgcInstallerOptions) {
    this.#runner = options.runner ?? nodeToolCommandRunner;
    this.#downloader = options.downloader ?? new FetchToolDownloader();
    this.#environment = { ...options.environment };
    this.#expectedDescriptorDigest = reviewToolDescriptorDigest(
      options.expectedDescriptor ?? createCgcDescriptor(),
    );
  }

  async install(request: ToolInstallRequest): Promise<ToolInstallationResult> {
    const startedAt = performance.now();
    let createdDestination = false;
    try {
      const descriptor = assertIndexerDescriptor(request.descriptor, this.id);
      if (reviewToolDescriptorDigest(descriptor) !== this.#expectedDescriptorDigest) {
        throw new Error('CGC descriptor is not the pinned installer descriptor');
      }
      if (
        descriptor.platform.operatingSystem !== process.platform
        || descriptor.platform.architecture !== process.arch
      ) throw new Error('CGC descriptor does not match the current host platform');
      if (descriptor.distribution.digest === undefined) {
        throw new Error('CGC installation requires an immutable binary digest');
      }
      const executable = join(
        request.destinationDirectory,
        ...descriptor.healthProbe.executable.split('/'),
      );
      await mkdir(request.destinationDirectory, { mode: 0o755 });
      createdDestination = true;
      await mkdir(join(request.destinationDirectory, 'bin'), { mode: 0o755 });
      await chmod(request.destinationDirectory, 0o755);
      await chmod(join(request.destinationDirectory, 'bin'), 0o755);
      await this.#downloader.download({
        url: descriptor.distribution.source,
        destination: executable,
        timeoutMs: request.timeoutMs,
        maximumBytes: MAX_BINARY_BYTES,
      });
      await assertFileContentDigest(executable, descriptor.distribution.digest);
      await chmod(executable, 0o755);
      const manifest = await createInstalledToolManifest(
        descriptor,
        request.destinationDirectory,
        [descriptor.healthProbe.executable],
      );
      return { status: 'installed', manifest, diagnostics: [], durationMs: performance.now() - startedAt };
    } catch (error) {
      if (createdDestination) {
        try {
          await rm(request.destinationDirectory, { force: true, recursive: true });
        } catch {
          // The manager also performs best-effort cleanup before returning failure.
        }
      }
      return failedInstallation(startedAt, 'cgc-install-failed', error);
    }
  }

  async validate(request: ToolValidationRequest): Promise<ToolValidationResult> {
    try {
      const descriptor = assertIndexerDescriptor(request.descriptor, this.id);
      if (reviewToolDescriptorDigest(descriptor) !== this.#expectedDescriptorDigest) {
        throw new Error('CGC descriptor is not the pinned installer descriptor');
      }
    } catch (error) {
      return {
        status: 'invalid',
        diagnostics: [diagnostic('warning', 'cgc-descriptor-invalid', error instanceof Error ? error.message : String(error))],
        durationMs: 0,
      };
    }
    return validateInstalledTool(this.#runner, request, { environment: this.#environment });
  }
}
