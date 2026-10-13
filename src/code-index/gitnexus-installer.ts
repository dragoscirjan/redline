import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  nodeProcessSpawner,
  runBoundedProcess,
  type BoundedRunResult,
} from '../process-runner.js';

export const GITNEXUS_VERSION = '1.6.12';
export const GITNEXUS_ARCHIVE = {
  url: `https://registry.npmjs.org/gitnexus/-/gitnexus-${GITNEXUS_VERSION}.tgz`,
  digest: 'sha512:5b3fbe84e5bbdd2925b939102c96d1213f3e216eb8f4a99fe2623ef7d671cdc420d8d978eec4a395f7bcf4d37fab4baeb464ef6d57976983074434b39c3b24e6',
} as const;
export const GITNEXUS_DEPENDENCY_LOCK = {
  url: `https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/v${GITNEXUS_VERSION}/gitnexus/package-lock.json`,
  digest: 'sha256:d97b46eeb3c1cbc4e81ab0b13d84ccd50991b08c4b5488300088c234cc894678',
} as const;
export const GITNEXUS_LICENSE = {
  name: 'PolyForm Noncommercial License 1.0.0',
  url: 'https://polyformproject.org/licenses/noncommercial/1.0.0/',
} as const;

const HEALTH_SCRIPT = '.redline/health.mjs';
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;

type ContentDigest = `sha256:${string}` | `sha512:${string}`;

export interface GitNexusCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
}

export interface GitNexusCommandRunner {
  run(request: GitNexusCommandRequest): Promise<BoundedRunResult>;
}

export interface GitNexusDownloadRequest {
  readonly url: string;
  readonly destination: string;
  readonly timeoutMs: number;
  readonly maximumBytes: number;
}

export interface GitNexusDownloader {
  download(request: GitNexusDownloadRequest): Promise<void>;
}

const nodeCommandRunner: GitNexusCommandRunner = {
  run: (request) => runBoundedProcess(nodeProcessSpawner, request),
};

/** Bounded HTTPS downloader that never replaces a caller-owned destination. */
export class FetchGitNexusDownloader implements GitNexusDownloader {
  async download(request: GitNexusDownloadRequest): Promise<void> {
    const requestedUrl = new URL(request.url);
    if (requestedUrl.protocol !== 'https:') throw new Error('GitNexus downloads require HTTPS');
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error('GitNexus download timeout must be a positive safe integer');
    }
    if (!Number.isSafeInteger(request.maximumBytes) || request.maximumBytes <= 0) {
      throw new Error('GitNexus download byte limit must be a positive safe integer');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let handle;
    let createdDestination = false;
    try {
      handle = await open(request.destination, 'wx', 0o600);
      createdDestination = true;
      const response = await fetch(requestedUrl, { signal: controller.signal });
      if (!response.ok || response.body === null) {
        throw new Error(`GitNexus download returned HTTP ${response.status}`);
      }
      if (new URL(response.url).protocol !== 'https:') {
        throw new Error('GitNexus download redirected outside HTTPS');
      }
      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== null) {
        const bytes = Number(declaredLength);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > request.maximumBytes) {
          throw new Error('GitNexus download exceeds its byte limit');
        }
      }

      const reader = response.body.getReader();
      let received = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > request.maximumBytes) {
          await reader.cancel();
          throw new Error('GitNexus download exceeds its byte limit');
        }
        await handle.write(Buffer.from(chunk.value));
      }
      await handle.sync();
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Preserve the download failure; destination cleanup remains best effort.
        } finally {
          handle = undefined;
        }
      }
      if (createdDestination) {
        try {
          await rm(request.destination, { force: true });
        } catch {
          // Preserve the bounded download failure.
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (handle !== undefined) await handle.close();
    }
  }
}

export interface GitNexusInstallationSources {
  readonly archive: {
    readonly url: string;
    readonly digest: `sha512:${string}`;
  };
  readonly dependencyLock: {
    readonly url: string;
    readonly digest: `sha256:${string}`;
  };
}

export interface GitNexusInstallationOptions {
  readonly destinationDirectory: string;
  readonly workDirectory: string;
  readonly nodeExecutable: string;
  readonly npmExecutable: string;
  readonly tarExecutable: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly runner?: GitNexusCommandRunner;
  readonly downloader?: GitNexusDownloader;
  /** Controlled-upgrade and test seam. Production uses the pinned sources above. */
  readonly sources?: GitNexusInstallationSources;
}

interface InstalledFile {
  readonly path: string;
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
  readonly mode: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertAbsoluteExecutable(path: string, name: string): void {
  if (!isAbsolute(path)) throw new Error(`${name} executable path must be absolute`);
}

function assertDigest(digest: ContentDigest, algorithm: 'sha256' | 'sha512'): void {
  const length = algorithm === 'sha256' ? 64 : 128;
  if (!new RegExp(`^${algorithm}:[0-9a-f]{${length}}$`, 'u').test(digest)) {
    throw new Error(`GitNexus ${algorithm} digest is invalid`);
  }
}

function assertSupportedNodeRuntime(): void {
  const [majorText, minorText] = process.versions.node.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  const supported = (major === 22 && minor >= 18) || (major >= 24 && (major > 24 || minor >= 11));
  if (!supported) throw new Error(`GitNexus ${GITNEXUS_VERSION} does not support Node ${process.versions.node}`);
}

function corePlatformPackage(): string {
  const key = `${process.platform}-${process.arch}`;
  const supported = new Set([
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ]);
  if (!supported.has(key)) {
    throw new Error(`GitNexus ${GITNEXUS_VERSION} has no pinned native package for ${key}`);
  }
  return `@ladybugdb/core-${key}`;
}

function installationEnvironment(
  temporaryDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return {
    ...environment,
    HOME: join(temporaryDirectory, 'home'),
    USERPROFILE: join(temporaryDirectory, 'home'),
    npm_config_audit: 'false',
    npm_config_cache: join(temporaryDirectory, 'npm-cache'),
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

async function fileDigest(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash(algorithm);
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function assertFileDigest(path: string, expected: ContentDigest): Promise<void> {
  const separator = expected.indexOf(':');
  const algorithm = expected.slice(0, separator) as 'sha256' | 'sha512';
  const expectedHex = expected.slice(separator + 1);
  if (await fileDigest(path, algorithm) !== expectedHex) {
    throw new Error('downloaded GitNexus content does not match its pinned digest');
  }
}

async function scanInstalledDirectory(
  root: string,
  relativeDirectory: string,
  normalize: boolean,
): Promise<InstalledFile[]> {
  const directory = relativeDirectory.length === 0 ? root : join(root, ...relativeDirectory.split('/'));
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`GitNexus installation contains an invalid directory: ${relativeDirectory || '.'}`);
  }
  if (normalize) await chmod(directory, 0o755);
  else if ((metadata.mode & 0o777) !== 0o755) {
    throw new Error(`GitNexus installation directory mode changed: ${relativeDirectory || '.'}`);
  }

  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  const files: InstalledFile[] = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`GitNexus installation contains a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) {
      const nested = await scanInstalledDirectory(root, relativePath, normalize);
      if (nested.length === 0) {
        if (!normalize) throw new Error(`GitNexus installation contains an empty directory: ${relativePath}`);
        await rm(absolutePath, { recursive: true });
      } else {
        files.push(...nested);
      }
      continue;
    }
    if (!entry.isFile()) throw new Error(`GitNexus installation contains an unsupported entry: ${relativePath}`);

    const initial = await lstat(absolutePath);
    const executable = relativePath === HEALTH_SCRIPT || (initial.mode & 0o111) !== 0;
    const normalizedMode = executable ? 0o755 : 0o644;
    if (normalize) await chmod(absolutePath, normalizedMode);
    const current = await lstat(absolutePath);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`GitNexus installation changed while validating: ${relativePath}`);
    }
    files.push({
      path: relativePath,
      digest: `sha256:${await fileDigest(absolutePath, 'sha256')}`,
      bytes: current.size,
      mode: current.mode & 0o777,
    });
  }
  return files;
}

function commandFailure(result: BoundedRunResult, fallback: string): Error {
  const message = [result.error, result.stderr, result.stdout]
    .find((value) => value !== undefined && value.length > 0) ?? fallback;
  return new Error(message);
}

async function runRequired(
  runner: GitNexusCommandRunner,
  request: GitNexusCommandRequest,
  name: string,
): Promise<BoundedRunResult> {
  const result = await runner.run(request);
  if (result.timedOut) throw new Error(`${name} timed out`);
  if (result.code === null) throw commandFailure(result, `${name} is unavailable`);
  if (result.code !== 0) throw commandFailure(result, `${name} exited ${result.code}`);
  return result;
}

/** Installs and validates the pinned GitNexus build for the code-index action. */
export async function installGitNexus(options: GitNexusInstallationOptions): Promise<string> {
  assertAbsoluteExecutable(options.nodeExecutable, 'node');
  assertAbsoluteExecutable(options.npmExecutable, 'npm');
  assertAbsoluteExecutable(options.tarExecutable, 'tar');
  if (!isAbsolute(options.destinationDirectory) || !isAbsolute(options.workDirectory)) {
    throw new Error('GitNexus installation directories must be absolute');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('GitNexus installation timeout must be a positive safe integer');
  }
  assertSupportedNodeRuntime();
  const nativePackage = corePlatformPackage();
  const sources = options.sources ?? {
    archive: GITNEXUS_ARCHIVE,
    dependencyLock: GITNEXUS_DEPENDENCY_LOCK,
  };
  assertDigest(sources.archive.digest, 'sha512');
  assertDigest(sources.dependencyLock.digest, 'sha256');

  const runner = options.runner ?? nodeCommandRunner;
  const downloader = options.downloader ?? new FetchGitNexusDownloader();
  const deadline = performance.now() + options.timeoutMs;
  const remaining = (): number => Math.max(1, Math.floor(deadline - performance.now()));
  let temporaryDirectory: string | undefined;
  let createdDestination = false;
  let completed = false;
  try {
    await mkdir(options.workDirectory, { recursive: true, mode: 0o755 });
    await chmod(options.workDirectory, 0o755);
    temporaryDirectory = await mkdtemp(join(options.workDirectory, '.gitnexus-install-'));
    const archive = join(temporaryDirectory, `gitnexus-${GITNEXUS_VERSION}.tgz`);
    await downloader.download({
      url: sources.archive.url,
      destination: archive,
      timeoutMs: remaining(),
      maximumBytes: MAX_ARCHIVE_BYTES,
    });
    await assertFileDigest(archive, sources.archive.digest);

    await mkdir(options.destinationDirectory, { mode: 0o755 });
    createdDestination = true;
    const environment = installationEnvironment(temporaryDirectory, options.environment);
    await runRequired(runner, {
      command: options.tarExecutable,
      args: ['-xzf', archive, '--strip-components=1', '-C', options.destinationDirectory],
      cwd: temporaryDirectory,
      env: environment,
      timeoutMs: remaining(),
    }, 'GitNexus archive extraction');

    const lockfile = join(options.destinationDirectory, 'package-lock.json');
    await downloader.download({
      url: sources.dependencyLock.url,
      destination: lockfile,
      timeoutMs: remaining(),
      maximumBytes: MAX_LOCK_BYTES,
    });
    await assertFileDigest(lockfile, sources.dependencyLock.digest);
    await chmod(lockfile, 0o644);

    await runRequired(runner, {
      command: options.npmExecutable,
      args: ['ci', '--ignore-scripts', '--no-bin-links', '--omit=dev', '--no-audit', '--no-fund'],
      cwd: options.destinationDirectory,
      env: environment,
      timeoutMs: remaining(),
    }, 'GitNexus dependency installation');

    const nodeModules = join(options.destinationDirectory, 'node_modules');
    await copyFile(
      join(nodeModules, ...nativePackage.split('/'), 'lbugjs.node'),
      join(nodeModules, '@ladybugdb', 'core', 'lbugjs.node'),
    );
    await rm(join(nodeModules, '@huggingface', 'transformers'), { force: true, recursive: true });
    await rm(join(nodeModules, 'onnxruntime-node'), { force: true, recursive: true });

    const healthDirectory = join(options.destinationDirectory, '.redline');
    await mkdir(healthDirectory, { mode: 0o755 });
    await writeFile(join(options.destinationDirectory, HEALTH_SCRIPT), [
      "await import('@ladybugdb/core');",
      "await import('tree-sitter');",
      "await import('tree-sitter-javascript');",
      `console.log('GitNexus ${GITNEXUS_VERSION} native-ok');`,
      '',
    ].join('\n'), { mode: 0o755 });

    const expectedTree = await scanInstalledDirectory(options.destinationDirectory, '', true);
    const validatedTree = await scanInstalledDirectory(options.destinationDirectory, '', false);
    if (JSON.stringify(validatedTree) !== JSON.stringify(expectedTree)) {
      throw new Error('GitNexus installed tree changed during validation');
    }

    const health = await runRequired(runner, {
      command: options.nodeExecutable,
      args: [join(options.destinationDirectory, HEALTH_SCRIPT), '--version'],
      cwd: options.destinationDirectory,
      env: options.environment,
      timeoutMs: remaining(),
    }, 'GitNexus health probe');
    if (health.stdoutTruncated || health.stdout.trim() !== `GitNexus ${GITNEXUS_VERSION} native-ok`) {
      throw new Error('GitNexus health probe returned unexpected output');
    }

    const executable = join(options.destinationDirectory, 'dist', 'cli', 'index.js');
    const executableInfo = await lstat(executable);
    if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) {
      throw new Error('GitNexus CLI is not a regular file');
    }
    completed = true;
    return executable;
  } finally {
    if (createdDestination && !completed) {
      try {
        await rm(options.destinationDirectory, { force: true, recursive: true });
      } catch {
        // Preserve the acquisition failure.
      }
    }
    if (temporaryDirectory !== undefined) {
      try {
        await rm(temporaryDirectory, { force: true, recursive: true });
      } catch {
        // The action-owned work directory is ephemeral and reclaimed by the runner.
      }
    }
  }
}
