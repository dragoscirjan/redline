import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { ReviewApplication, executePreparedReview, type CompositeReporter, type ReviewReport } from '../application/review.ts';
import { createHarnessExecutor } from '../harness-executor/registry.ts';
import { GitRevisionSource } from './git-source.ts';
import type { LocalOptions } from './options.ts';
import { cancellableSpawner, harnessCommand, inside, LocalOperationError } from './process.ts';
import { prepareLocalContext } from './context.ts';
import { localReviewReuse } from './reuse.ts';
import { terminalText } from './reporter.ts';

export interface LocalRunResult {
  readonly exitCode: number;
  readonly status: 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'deadline-exhausted';
  readonly outputDirectory?: string;
  readonly report?: Pick<ReviewReport, 'review' | 'summary'>;
  readonly failureKind?: 'configuration' | 'revision' | 'model';
}
export interface LocalRunDependencies {
  readonly signal: AbortSignal;
  readonly reporter: (directory: string) => CompositeReporter;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly onOutput?: (directory: string) => void;
}

/** Shared local execution. Transports own presentation, never review policy. */
export async function runLocalReview(options: LocalOptions, env: NodeJS.ProcessEnv, dependencies: LocalRunDependencies): Promise<LocalRunResult> {
  const { stdout, stderr } = dependencies;
  const controller = new AbortController();
  const signal = AbortSignal.any([dependencies.signal, controller.signal]);
  let output: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let deadlineExpired = false;
  let failureKind: 'configuration' | 'revision' | 'model' = 'configuration';
  try {
    signal.throwIfAborted();
    // Preflight harness availability before capture/output creation. Never search repository-local PATH entries.
    const launch = options.environment.harness === 'echo' ? undefined
      : await harnessCommand(options.environment.harness, env.PATH ?? '', options.repository);
    const executor = createHarnessExecutor(options.environment.harness, {
      ...(launch === undefined ? {} : { command: launch.command }), spawner: cancellableSpawner(signal, launch),
    });
    if (options.output === undefined) {
      if (inside(options.repository, options.stateDirectory)) throw new LocalOperationError('default output must be outside the reviewed repository');
      let ancestor = options.stateDirectory;
      while (true) {
        const canonicalAncestor = await realpath(ancestor).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw new LocalOperationError('default output parent directory is inaccessible');
        });
        if (canonicalAncestor !== undefined) {
          if (inside(options.repository, canonicalAncestor)) throw new LocalOperationError('output directory symlink enters the reviewed repository');
          break;
        }
        ancestor = dirname(ancestor);
      }
      await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 }).catch(() => {
        throw new LocalOperationError('cannot create default output directory');
      });
      const canonical = await realpath(options.stateDirectory).catch(() => {
        throw new LocalOperationError('default output directory is unavailable');
      });
      if (inside(options.repository, canonical)) throw new LocalOperationError('default output is inside the reviewed repository');
      output = await mkdtemp(join(canonical, 'run-')).catch(() => {
        throw new LocalOperationError('cannot create a run directory in the default output directory');
      });
    } else {
      // Output must be new: never overwrite an old run or follow an existing output symlink.
      const parent = await realpath(resolve(options.output, '..')).catch(() => {
        throw new LocalOperationError('output parent directory is unavailable');
      });
      if (inside(options.repository, options.output) || inside(options.repository, parent)) {
        throw new LocalOperationError('output must be outside the reviewed repository');
      }
      await mkdir(options.output, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        const reason = error.code === 'EEXIST' ? 'output directory already exists'
          : error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'output parent directory is unavailable'
          : error.code === 'EACCES' || error.code === 'EPERM' ? 'permission denied creating output directory'
          : 'could not create output directory';
        throw new LocalOperationError(reason);
      });
      output = options.output;
    }
    const destination = output;
    dependencies.onOutput?.(destination);
    if (options.environment.maxOutputTokens !== undefined) stdout(`Output budget: ${options.environment.maxOutputTokens} tokens per model call`);
    const reporter = dependencies.reporter(destination);
    const start = performance.now();
    timer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, options.environment.runTimeout.milliseconds);
    let reuse: Awaited<ReturnType<typeof localReviewReuse>>;
    stdout(`Model protocol: ${options.environment.modelProtocol}; requested controls are not proof the model honors them.`);
    if (options.environment.harness === 'opencode') stdout('OpenCode retains native provider retries inside each review attempt. --retries counts review attempts, not HTTP requests.');
    if (options.environment.modelProtocol === 'openrouter-json'
      && (options.environment.harness !== 'pi' || options.environment.model.provider !== 'openrouter')) {
      throw new LocalOperationError('openrouter-json requires the Pi harness and openrouter provider; no silent protocol fallback');
    }
    const application = new ReviewApplication({
      source: new GitRevisionSource(options, env, destination), reporter,
      prepareContext: async (capture, contextSignal) => {
        reuse = await localReviewReuse(capture, options);
        stderr(`Review reuse: ${options.reuse === 'disabled' ? 'disabled' : reuse === undefined ? 'unavailable' : 'enabled'}`);
        if (options.indexing.mode === 'disabled') return undefined;
        reporter.progress({ kind: 'context-started', provider: options.indexing.artifact === undefined ? options.indexing.provider : 'imported' });
        const context = await prepareLocalContext(capture, options, env, destination, contextSignal,
          Math.max(1, options.environment.runTimeout.milliseconds - (performance.now() - start)));
        reporter.progress({ kind: 'context-ready', status: context.coverage.status, relatedSpans: context.coverage.relatedSpans, fileOnlyFiles: context.fileOnlyReviewedFiles, indexCache: context.indexCache });
        if (options.indexing.mode === 'required' && context.fileOnlyReviewedFiles > 0) {
          throw new LocalOperationError('required indexed context is missing source-validated related spans for one or more reviewed files; review was not started');
        }
        return context.input;
      },
      execute: (input) => {
        failureKind = 'model';
        signal.throwIfAborted();
        const remaining = Math.max(1, Math.floor(options.environment.runTimeout.milliseconds - (performance.now() - start)));
        return executePreparedReview({ ...input,
          sleep: milliseconds => sleep(milliseconds, undefined, { signal }),
          environment: { ...input.environment, reuse, runTimeout: { minutes: remaining / 60_000, milliseconds: remaining } },
          executor: {
            harness: executor.harness,
            prepare: (settings) => { signal.throwIfAborted(); return executor.prepare(settings); },
            execute: (prepared, prompt, executeOptions) => { signal.throwIfAborted(); return executor.execute(prepared, prompt, executeOptions); },
          },
        });
      },
    });
    failureKind = 'revision';
    const result = await application.run({ environment: { ...options.environment, outputDirectory: destination } }, signal);
    const incomplete = result.summary.omittedFiles > 0 || ['incomplete', 'unavailable'].includes(result.review.coverage.files.status);
    let code = incomplete ? 1 : result.exitCode;
    if (code === 0 && options.failOn !== 'none') {
      const severities = options.failOn === 'critical' ? ['critical'] : options.failOn === 'high' ? ['critical', 'high'] : ['critical', 'high', 'medium', 'low'];
      if (result.review.findings.some((finding) => severities.includes(finding.severity))) code = 3;
    }
    if (reporter.failures.size > 0) code = 5;
    await writeFile(join(destination, 'status.json'), `${JSON.stringify({ version: 1, status: code === 0 || code === 3 ? 'completed' : 'incomplete', exitCode: code, ...(options.environment.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.environment.maxOutputTokens }), modelProtocol: options.environment.modelProtocol, retries: options.environment.retries, reporterFailures: [...reporter.failures] }, null, 2)}\n`);
    return { exitCode: code, status: code === 0 || code === 3 ? 'completed' : 'incomplete', outputDirectory: destination, report: { review: result.review, summary: result.summary } };
  } catch (error) {
    if (error instanceof LocalOperationError) stderr(`redline: ${terminalText(error.message, options.environment.credential?.value)}`);
    const status = signal.aborted ? deadlineExpired ? 'deadline-exhausted' : 'cancelled' : 'failed';
    const code = status === 'cancelled' ? 130 : 1;
    stderr(`redline: ${status}; ${output === undefined ? 'no output created' : `partial artifacts: ${terminalText(output, options.environment.credential?.value)}`}`);
    if (output !== undefined) await writeFile(join(output, 'status.json'), `${JSON.stringify({ version: 1, status, exitCode: code })}\n`).catch(() => undefined);
    return { exitCode: code, status, failureKind, ...(output === undefined ? {} : { outputDirectory: output }) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
