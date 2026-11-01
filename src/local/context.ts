/** Local tool discovery only; the shared context builder owns artifact preparation. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { CapturedRevision } from '../application/review.ts';
import { prepareReviewContext, type PreparedReviewContext } from '../code-index/context.ts';
import type { LocalOptions } from './options.ts';
import { cancellableSpawner, executable, hostToolCommand, inside, LocalOperationError, type LaunchCommand } from './process.ts';

const CGC_LINUX_SHA256 = '9b62140c77e88d153de24abfaebe1977f320511b170bf9aea6087106601d0e5f';

async function suppliedCommand(path: string, repository: string): Promise<LaunchCommand> {
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isFile() || inside(repository, canonical) || /\.(?:cmd|bat|ps1)$/iu.test(canonical)) {
    throw new LocalOperationError('indexer must be a trusted executable or Node entrypoint outside the repository');
  }
  return /\.(?:mjs|cjs|js)$/iu.test(canonical) ? { command: process.execPath, prefix: [canonical] } : { command: canonical, prefix: [] };
}

export async function providerCommand(options: LocalOptions, env: NodeJS.ProcessEnv,
  probe: { realpath(path: string): Promise<string>; readFile(path: string): Promise<Buffer> } = { realpath, readFile }): Promise<LaunchCommand> {
  if (options.indexing.executable !== undefined) return suppliedCommand(options.indexing.executable, options.repository);
  if (options.indexing.provider === 'cgc' && process.platform === 'linux' && process.arch === 'x64') {
    const path = join(dirname(options.stateDirectory), 'tools/cgc/0.5.7/linux-x64/cgc');
    const info = await lstat(path).catch(() => undefined);
    if (info?.isFile() && !info.isSymbolicLink() && info.size <= 80 * 1024 * 1024) {
      try {
        const canonical = await probe.realpath(path);
        if (!inside(options.repository, canonical)) {
          const hash = createHash('sha256').update(await probe.readFile(canonical)).digest('hex');
          if (hash === CGC_LINUX_SHA256) return { command: canonical, prefix: [] };
        }
      } catch {
        // A managed-tool probe is optional. Explicit executable overrides
        // still fail closed; automatic discovery can try a trusted PATH.
      }
    }
  }
  return hostToolCommand(options.indexing.provider, env.PATH ?? env.Path ?? '', options.repository);
}

export async function prepareLocalContext(capture: CapturedRevision, options: LocalOptions, env: NodeJS.ProcessEnv,
  outputDirectory: string, signal: AbortSignal, remainingMs: number): Promise<PreparedReviewContext> {
  const directories: string[] = [];
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!isAbsolute(directory) || inside(options.repository, directory)) continue;
    const canonical = await realpath(directory).catch(() => undefined);
    if (canonical !== undefined && !inside(options.repository, canonical)) directories.push(canonical);
  }
  const python = async (): Promise<string> => {
    if (options.indexing.runtime !== undefined) {
      const command = await suppliedCommand(options.indexing.runtime, options.repository);
      if (command.prefix.length !== 0) throw new LocalOperationError('index runtime must be a Python executable');
      return command.command;
    }
    for (const name of ['python3', 'python']) {
      const found = await executable(name, directories.join(delimiter), options.repository).catch(() => undefined);
      if (found !== undefined && !found.toLowerCase().includes('windowsapps')) return found;
    }
    throw new LocalOperationError('Python is unavailable for code-context preparation');
  };
  const credential = options.environment.credential?.value;
  const cacheAnchor = env.XDG_CACHE_HOME === undefined ? dirname(options.stateDirectory) : join(resolve(env.XDG_CACHE_HOME), 'redline');
  return prepareReviewContext(capture, {
    provider: options.indexing.provider, outputDirectory,
    importedArtifact: options.indexing.artifact, repository: options.indexing.repository,
    timeoutMs: Math.max(1, Math.min(remainingMs, 5 * 60_000)), hostPath: directories.join(delimiter),
    systemRoot: env.SystemRoot ?? env.SYSTEMROOT,
    cacheDirectory: join(cacheAnchor, 'indexes', 'v1'), cacheAnchor, repositoryDirectory: options.repository,
    spawner: cancellableSpawner(signal), resolveProvider: () => providerCommand(options, env), resolvePython: python,
    redact: (text) => credential === undefined ? text : text.split(credential).join('[redacted]'),
  }, signal);
}
