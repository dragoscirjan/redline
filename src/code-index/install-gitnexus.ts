import { lstat, mkdir } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import {
  GitNexusInstaller,
  createGitNexusDescriptor,
} from '../artifact-cache/installers/gitnexus.js';

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function requiredAbsolutePath(value: string | undefined, name: string): string {
  if (value === undefined || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

async function main(): Promise<void> {
  const [destinationValue, workValue, nodeValue, npmValue, tarValue, ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error('unexpected installer arguments');
  const destinationDirectory = requiredAbsolutePath(destinationValue, 'destination');
  const workDirectory = requiredAbsolutePath(workValue, 'work directory');
  const nodeExecutable = requiredAbsolutePath(nodeValue, 'node executable');
  const npmExecutable = requiredAbsolutePath(npmValue, 'npm executable');
  const tarExecutable = requiredAbsolutePath(tarValue, 'tar executable');
  await mkdir(workDirectory, { recursive: true, mode: 0o755 });

  const descriptor = createGitNexusDescriptor();
  const safePath = [...new Set([
    dirname(nodeExecutable),
    dirname(npmExecutable),
    dirname(tarExecutable),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ])].join(delimiter);
  const installer = new GitNexusInstaller({
    nodeExecutable,
    npmExecutable,
    tarExecutable,
    environment: {
      HOME: workDirectory,
      PATH: safePath,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TMPDIR: workDirectory,
    },
  });
  const installed = await installer.install({
    descriptor,
    destinationDirectory,
    workDirectory,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (installed.status !== 'installed') {
    throw new Error(`GitNexus installation ended with status ${installed.status}`);
  }
  const validated = await installer.validate({
    descriptor,
    installationDirectory: destinationDirectory,
    manifest: installed.manifest,
    timeoutMs: 60_000,
  });
  if (validated.status !== 'valid') {
    throw new Error(`GitNexus validation ended with status ${validated.status}`);
  }

  const executable = join(destinationDirectory, 'dist', 'cli', 'index.js');
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('GitNexus CLI is not a regular file');
  }
  process.stdout.write(`${executable}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`redline gitnexus installer: ${message}\n`);
  process.exitCode = 2;
}
