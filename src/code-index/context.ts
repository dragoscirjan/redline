/** Host-side context preparation shared with the action's Python artifact builder. */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { acquireBaseIndex, type BaseIndexLease } from './cache.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapturedRevision } from '../application/review.ts';
import { loadCodeContextArtifact, type CodeContextArtifact } from '../code-context/artifact.ts';
import { loadReviewBundle } from '../review/bundle.ts';
import { codeContextForFile, loadReviewCodeContext, type ReviewCodeContextInput } from '../review/indexed-context.ts';
import { runBoundedProcess, type ProcessSpawner } from '../process-runner.ts';

export const INDEX_PROVIDER_VERSIONS = { cgc: '0.5.7', gitnexus: '1.6.12' } as const;
export type IndexProviderId = keyof typeof INDEX_PROVIDER_VERSIONS;
export interface IndexCommand { readonly command: string; readonly prefix: readonly string[] }
export interface ContextPreparationOptions {
  readonly provider: IndexProviderId;
  readonly outputDirectory: string;
  readonly importedArtifact?: string | undefined;
  readonly repository?: string | undefined;
  readonly timeoutMs: number;
  readonly hostPath: string;
  readonly systemRoot?: string | undefined;
  readonly spawner: ProcessSpawner;
  readonly resolveProvider: () => Promise<IndexCommand>;
  readonly resolvePython: () => Promise<string>;
  readonly redact?: (text: string) => string;
  readonly cacheDirectory?: string | undefined;
  readonly cacheAnchor?: string | undefined;
  readonly repositoryDirectory?: string | undefined;
}
export interface PreparedReviewContext {
  readonly input: ReviewCodeContextInput;
  readonly fileOnlyReviewedFiles: number;
  readonly indexCache: 'reused' | 'rebuilt' | 'uncached' | 'not-needed' | 'unavailable' | 'imported';
  readonly coverage: Awaited<ReturnType<typeof loadReviewCodeContext>>['coverage'];
}

export async function prepareReviewContext(capture: CapturedRevision, options: ContextPreparationOptions, signal: AbortSignal): Promise<PreparedReviewContext> {
  signal.throwIfAborted();
  const bundle = await loadReviewBundle(capture.reviewDirectory, capture.sourceDirectory);
  const repository = options.repository ?? capture.contextSnapshot?.repository;
  if (repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('context repository identity is required');
  const directory = join(options.outputDirectory, 'index');
  const artifactPath = join(directory, 'code-context.json');
  const home = join(directory, 'home');
  let cache = join(directory, 'cache');
  const temporary = join(directory, 'tmp');
  await Promise.all([home, cache, temporary].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const environment: NodeJS.ProcessEnv = {
    PATH: options.hostPath, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: cache,
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, RUNNER_TEMP: temporary,
    PYTHONDONTWRITEBYTECODE: '1', REDLINE_CONTEXT_HOST_PATH: options.hostPath,
    CGC_IGNORE_PROJECT_ENV: '1', ENABLE_AUTO_WATCH: 'false', SCIP_INDEXER: 'false', INDEX_SOURCE: 'false',
    ...(options.systemRoot === undefined ? {} : { SystemRoot: options.systemRoot }),
  };
  const provider = { id: options.provider, version: INDEX_PROVIDER_VERSIONS[options.provider] };
  const unavailable = (code: string): CodeContextArtifact => ({
    version: 2, repository, revision: bundle.manifest.head, baseRevision: bundle.manifest.base,
    provider, status: 'unavailable', files: [], diagnostics: [{ level: 'warning', code, message: code }],
    timings: { installationMs: 0, restoreMs: 0, validationMs: 0, indexMs: 0, queryMs: 0, saveMs: null },
  });
  const save = async (artifact: CodeContextArtifact): Promise<void> => {
    const redacted = { ...artifact, diagnostics: artifact.diagnostics.map((item) => ({
      ...item, code: (options.redact?.(item.code) ?? item.code) === item.code ? item.code : 'credential-redacted',
      message: options.redact?.(item.message) ?? item.message,
    })) };
    await writeFile(artifactPath, `${JSON.stringify(redacted, null, 2)}\n`, { mode: 0o600 });
  };
  let lease: BaseIndexLease | undefined;
  let socketDirectory: string | undefined;
  let indexCache: PreparedReviewContext['indexCache'] = options.importedArtifact === undefined ? 'unavailable' : 'imported';
  const started = performance.now();
  const remaining = (): number => Math.max(1, Math.floor(options.timeoutMs - (performance.now() - started)));
  try {
    if (options.importedArtifact !== undefined) {
      const artifact = await loadCodeContextArtifact(options.importedArtifact);
      if (artifact.repository !== repository || artifact.revision !== bundle.manifest.head
        || (artifact.baseRevision !== undefined && artifact.baseRevision !== bundle.manifest.base)) {
        throw new Error('imported context identity mismatch');
      }
      await save(artifact);
    } else {
      if (capture.contextSnapshot === undefined) throw new Error('context source capture unavailable');
      const command = await options.resolveProvider();
      signal.throwIfAborted();
      const health = await runBoundedProcess(options.spawner, {
        command: command.command, args: [...command.prefix, options.provider === 'cgc' ? 'version' : '--version'],
        cwd: home, env: environment, timeoutMs: Math.min(30_000, remaining()),
      });
      const version = [health.stdout.trim(), health.stderr.trim()].filter(Boolean).join('\n');
      if (health.code !== 0 || health.timedOut || health.stdoutTruncated || health.stderrTruncated
        || (options.provider === 'cgc' ? version !== `CodeGraphContext ${provider.version}` : version !== provider.version)) {
        await save(unavailable('index-provider-version-unavailable'));
      } else {
        const python = await options.resolvePython();
        const configuration = `${options.provider}-captured-source-v2-${createHash('sha256')
          .update(await readFile(new URL('./export.py', import.meta.url)))
          .update(await readFile(new URL('./gitnexus-query.mjs', import.meta.url)))
          .update(JSON.stringify({ command: command.command, prefix: command.prefix })).digest('hex')}`;
        if (options.cacheDirectory !== undefined && options.repositoryDirectory !== undefined) {
          lease = await acquireBaseIndex(options.cacheDirectory, options.repositoryDirectory, {
            repository, base: bundle.manifest.base, provider: provider.id, providerVersion: provider.version,
            configuration, platform: `${process.platform}-${process.arch}`,
          }, python, environment, signal, remaining(), options.cacheAnchor).catch(() => undefined);
          signal.throwIfAborted();
          if (lease !== undefined) cache = join(lease.directory, 'cache');
        }
        socketDirectory = await mkdtemp(join(tmpdir(), 'rl-index-'));
        const sources = await capture.contextSnapshot.prepareSources(lease === undefined ? undefined : join(lease.directory, 'base'));
        signal.throwIfAborted();
        const executable = command.prefix.length === 1 ? command.prefix[0]! : command.command;
        if (command.prefix.length > 1 || (options.provider === 'gitnexus' && command.prefix.length !== 1)) throw new Error('unsupported indexer launch shape');
        const result = await runBoundedProcess(options.spawner, {
          command: python, cwd: home, env: environment, timeoutMs: remaining(),
          args: ['-I', '-B', fileURLToPath(new URL('./export.py', import.meta.url)), 'build',
            '--provider', options.provider, '--provider-version', provider.version, '--mode', 'review',
            '--base', bundle.manifest.base, '--head', bundle.manifest.head, '--repository', repository,
            '--workspace', options.outputDirectory, '--output-directory', directory,
            ...(lease === undefined ? [] : ['--base-workspace', lease.directory]),
            '--socket-path', join(socketDirectory, 'f.sock'),
            '--prepared-manifest', join(capture.reviewDirectory, 'manifest.json'),
            '--source-root', sources.baseDirectory, '--head-source-root', sources.headDirectory,
            '--cache-root', cache, '--provider-home', options.provider === 'gitnexus' ? join(cache, 'gitnexus-home') : home, '--executable', executable,
            '--runtime-executable', command.command, '--query-adapter', fileURLToPath(new URL('./gitnexus-query.mjs', import.meta.url)),
            '--configuration-id', configuration, '--installation-ms', '0', '--restore-ms', '0',
            '--cache-matched-key', lease?.restored === true ? lease.key : '', '--cache-restore-outcome', lease?.restored === true ? 'success' : 'skipped', '--result-file', join(directory, 'build-result.json')],
        });
        signal.throwIfAborted();
        if (result.code !== 0 || result.timedOut || result.stdoutTruncated) await save(unavailable('index-provider-build-failed'));
        else {
          const artifact = await loadCodeContextArtifact(artifactPath);
          indexCache = artifact.diagnostics.some((item) => item.code === 'cache-base-revision') ? 'reused'
            : artifact.diagnostics.some((item) => item.code === 'cold-index-skipped') ? 'not-needed'
            : ['complete', 'partial'].includes(artifact.status) && artifact.timings?.indexMs !== null ? (lease === undefined ? 'uncached' : 'rebuilt') : 'unavailable';
          await save(lease === undefined && options.cacheDirectory !== undefined ? { ...artifact, diagnostics: [...artifact.diagnostics,
            { level: 'warning', code: 'local-index-cache-unavailable', message: 'Persistent base-index state was unavailable; fresh per-run preparation was used.' }] } : artifact);
        }
      }
    }
  } catch {
    signal.throwIfAborted();
    await save(unavailable(options.importedArtifact === undefined ? 'index-provider-unavailable' : 'imported-context-invalid'));
  } finally {
    // Release only after the bounded provider process has stopped. Retained
    // state is separate from per-run cleanup and never supplies head evidence.
    await lease?.release();
    for (const path of [home, join(directory, 'cache'), temporary, join(directory, 'base'), join(directory, 'head'),
      ...(socketDirectory === undefined ? [] : [socketDirectory])]) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const input = { path: artifactPath, repository };
  const loaded = await loadReviewCodeContext(bundle, input);
  const fileOnlyReviewedFiles = bundle.manifest.files.filter((file) => file.reviewed && codeContextForFile(loaded, file).coverage.relatedSpans === 0).length;
  await writeFile(join(directory, 'status.json'), `${JSON.stringify({ version: 1, provider: loaded.coverage.provider,
    status: loaded.coverage.status, relatedSpans: loaded.coverage.relatedSpans, fileOnlyReviewedFiles, indexCache, diagnosticCodes: loaded.coverage.diagnosticCodes }, null, 2)}\n`, { mode: 0o600 });
  return { input, coverage: loaded.coverage, fileOnlyReviewedFiles, indexCache };
}
