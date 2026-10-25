/** Host-side context preparation shared with the action's Python artifact builder. */
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
}
export interface PreparedReviewContext {
  readonly input: ReviewCodeContextInput;
  readonly fileOnlyReviewedFiles: number;
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
  const cache = join(directory, 'cache');
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
        const sources = await capture.contextSnapshot.prepareSources();
        signal.throwIfAborted();
        const executable = command.prefix.length === 1 ? command.prefix[0]! : command.command;
        if (command.prefix.length > 1 || (options.provider === 'gitnexus' && command.prefix.length !== 1)) throw new Error('unsupported indexer launch shape');
        const result = await runBoundedProcess(options.spawner, {
          command: python, cwd: home, env: environment, timeoutMs: remaining(),
          args: [fileURLToPath(new URL('./export.py', import.meta.url)), 'build',
            '--provider', options.provider, '--provider-version', provider.version, '--mode', 'review',
            '--base', bundle.manifest.base, '--head', bundle.manifest.head, '--repository', repository,
            '--workspace', options.outputDirectory, '--output-directory', directory,
            '--prepared-manifest', join(capture.reviewDirectory, 'manifest.json'),
            '--source-root', sources.baseDirectory, '--head-source-root', sources.headDirectory,
            '--cache-root', cache, '--provider-home', options.provider === 'gitnexus' ? join(cache, 'gitnexus-home') : home, '--executable', executable,
            '--runtime-executable', command.command, '--query-adapter', fileURLToPath(new URL('./gitnexus-query.mjs', import.meta.url)),
            '--configuration-id', `${options.provider}-base-only-captured-v1`, '--installation-ms', '0', '--restore-ms', '0',
            '--cache-matched-key', '', '--cache-restore-outcome', 'skipped', '--result-file', join(directory, 'build-result.json')],
        });
        signal.throwIfAborted();
        if (result.code !== 0 || result.timedOut || result.stdoutTruncated) await save(unavailable('index-provider-build-failed'));
        else await save(await loadCodeContextArtifact(artifactPath));
      }
    }
  } catch {
    signal.throwIfAborted();
    await save(unavailable(options.importedArtifact === undefined ? 'index-provider-unavailable' : 'imported-context-invalid'));
  } finally {
    // Provider configuration and databases are private, per-run scratch. Only the bounded artifact is retained.
    for (const path of [home, cache, temporary, join(directory, 'base'), join(directory, 'head')]) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const input = { path: artifactPath, repository };
  const loaded = await loadReviewCodeContext(bundle, input);
  const fileOnlyReviewedFiles = bundle.manifest.files.filter((file) => file.reviewed && codeContextForFile(loaded, file).coverage.relatedSpans === 0).length;
  await writeFile(join(directory, 'status.json'), `${JSON.stringify({ version: 1, provider: loaded.coverage.provider,
    status: loaded.coverage.status, relatedSpans: loaded.coverage.relatedSpans, fileOnlyReviewedFiles, diagnosticCodes: loaded.coverage.diagnosticCodes }, null, 2)}\n`, { mode: 0o600 });
  return { input, coverage: loaded.coverage, fileOnlyReviewedFiles };
}
