import { createHash } from 'node:crypto';
import { chmod, lstat, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  artifactPayloadDigest,
  parseArtifactFileEntries,
  parseInstalledToolManifest,
  reviewToolDescriptorDigest,
} from './contracts.js';
import {
  INSTALLED_TOOL_MANIFEST_VERSION,
  type ArtifactFileEntry,
  type InstalledToolManifest,
  type ReviewToolDescriptor,
} from './types.js';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function fileDigest(path: string): Promise<`sha256:${string}`> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
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
  return `sha256:${hash.digest('hex')}`;
}

interface PreparedDirectory {
  readonly files: ArtifactFileEntry[];
  readonly empty: boolean;
}

async function scanDirectory(
  root: string,
  relativeDirectory: string,
  executablePaths: ReadonlySet<string>,
  normalize: boolean,
): Promise<PreparedDirectory> {
  const directory = relativeDirectory.length === 0 ? root : join(root, ...relativeDirectory.split('/'));
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`installed tool directory is not a regular directory: ${relativeDirectory || '.'}`);
  }
  if (normalize) await chmod(directory, 0o755);
  else if ((metadata.mode & 0o777) !== 0o755) {
    throw new Error(`installed tool directory must use mode 0755: ${relativeDirectory || '.'}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  const files: ArtifactFileEntry[] = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`installed tool contains a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) {
      const nested = await scanDirectory(root, relativePath, executablePaths, normalize);
      if (nested.empty) {
        if (!normalize) throw new Error(`installed tool contains an empty directory: ${relativePath}`);
        await rm(absolutePath, { recursive: true });
      } else files.push(...nested.files);
      continue;
    }
    if (!entry.isFile()) throw new Error(`installed tool contains an unsupported entry: ${relativePath}`);
    const initial = await lstat(absolutePath);
    const executable = executablePaths.has(relativePath) || (initial.mode & 0o111) !== 0;
    const normalizedMode = executable ? 0o755 : 0o644;
    if (normalize) await chmod(absolutePath, normalizedMode);
    const current = await lstat(absolutePath);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`installed tool file changed while preparing its manifest: ${relativePath}`);
    }
    files.push({
      path: relativePath,
      digest: await fileDigest(absolutePath),
      bytes: current.size,
      mode: current.mode & 0o777,
    });
  }
  return { files, empty: files.length === 0 };
}

/** Normalizes portable modes, removes nested empty directories, and records an immutable installed tree. */
export async function createInstalledToolManifest(
  descriptor: ReviewToolDescriptor,
  installationDirectory: string,
  executablePaths: readonly string[],
): Promise<InstalledToolManifest> {
  const requestedExecutables = new Set(executablePaths);
  const prepared = await scanDirectory(installationDirectory, '', requestedExecutables, true);
  const files = parseArtifactFileEntries(prepared.files);
  return parseInstalledToolManifest({
    version: INSTALLED_TOOL_MANIFEST_VERSION,
    descriptorDigest: reviewToolDescriptorDigest(descriptor),
    payloadDigest: artifactPayloadDigest(files),
    files,
    executablePaths: [...executablePaths].sort(compareText),
  });
}

/** Inspects an installed tree without changing it. */
export async function inspectInstalledToolManifest(
  descriptor: ReviewToolDescriptor,
  installationDirectory: string,
  executablePaths: readonly string[],
): Promise<InstalledToolManifest> {
  const inspected = await scanDirectory(installationDirectory, '', new Set(executablePaths), false);
  const files = parseArtifactFileEntries(inspected.files);
  return parseInstalledToolManifest({
    version: INSTALLED_TOOL_MANIFEST_VERSION,
    descriptorDigest: reviewToolDescriptorDigest(descriptor),
    payloadDigest: artifactPayloadDigest(files),
    files,
    executablePaths: [...executablePaths].sort(compareText),
  });
}

/** Reconstructs the canonical warm-run manifest from a validated cache entry. */
export function installedToolManifestFromCache(
  descriptor: ReviewToolDescriptor,
  files: readonly ArtifactFileEntry[],
): InstalledToolManifest {
  return parseInstalledToolManifest({
    version: INSTALLED_TOOL_MANIFEST_VERSION,
    descriptorDigest: reviewToolDescriptorDigest(descriptor),
    payloadDigest: artifactPayloadDigest(files),
    files,
    executablePaths: [descriptor.healthProbe.executable],
  });
}
