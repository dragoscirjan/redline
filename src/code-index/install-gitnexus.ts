import { mkdir } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute } from 'node:path';
import { installGitNexus } from './gitnexus-installer.js';

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

  const safePath = [...new Set([
    dirname(nodeExecutable),
    dirname(npmExecutable),
    dirname(tarExecutable),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ])].join(delimiter);
  const executable = await installGitNexus({
    destinationDirectory,
    workDirectory,
    nodeExecutable,
    npmExecutable,
    tarExecutable,
    timeoutMs: INSTALL_TIMEOUT_MS,
    environment: {
      HOME: workDirectory,
      PATH: safePath,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TMPDIR: workDirectory,
    },
  });
  process.stdout.write(`${executable}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`redline gitnexus installer: ${message}\n`);
  process.exitCode = 2;
}
