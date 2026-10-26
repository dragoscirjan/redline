#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CapabilityError } from '../application/capabilities.ts';
import { CompositeReporter, ReviewApplication, executePreparedReview } from '../application/review.ts';
import { createHarnessExecutor } from '../harness-executor/registry.ts';
import { GitRevisionSource } from './git-source.ts';
import { HELP, parseLocalOptions, UsageError } from './options.ts';
import { cancellableSpawner, harnessCommand, inside, LocalOperationError } from './process.ts';
import { prepareLocalContext } from './context.ts';
import { FindingDiffReader } from './finding-diff.ts';
import { CliReporter, terminalColors, terminalText } from './reporter.ts';

export interface LocalCliDependencies {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  dependencies: LocalCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const stderr = dependencies.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  if (args.length === 1 && args[0] === '--version') {
    const metadata: { version: string } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    stdout(`redline ${metadata.version}`); return 0;
  }
  if ((args.length === 1 && args[0] === '--help') || (args.length === 2 && args[0] === 'review' && args[1] === '--help')) {
    stdout(HELP); return 0;
  }
  if (args[0] !== 'review') { stderr('redline: expected review; use --help'); return 2; }
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  const interrupted = dependencies.signal ?? controller.signal;
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const signal = AbortSignal.any([interrupted, controller.signal]);
  let options;
  try { options = await parseLocalOptions(args.slice(1), env, dependencies.cwd ?? process.cwd(), signal); }
  catch (error) {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    // Parse errors are trusted classifications; never echo raw argument/config values.
    stderr(`redline: ${signal.aborted ? 'cancelled' : error instanceof CapabilityError || error instanceof UsageError ? error.message : 'invalid configuration or repository; use --help'}`);
    return signal.aborted ? 130 : error instanceof CapabilityError ? 4 : 2;
  }
  let output: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let deadlineExpired = false;
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
    if (options.environment.maxOutputTokens !== undefined) stdout(`Output budget: ${options.environment.maxOutputTokens} tokens per model call`);
    const diffReader = new FindingDiffReader(join(destination, 'bundle'), join(destination, 'source'));
    const reporter = new CompositeReporter(options.reporters.map(() => new CliReporter(stdout, stderr, options.environment.credential?.value, {
      color: terminalColors(options.color, dependencies.stdout === undefined && process.stdout.isTTY === true, env),
      ...(dependencies.stderr === undefined && process.stderr.isTTY === true && env.TERM !== 'dumb' ? {
        terminal: {
          write: (text: string) => { process.stderr.write(text); }, columns: () => process.stderr.columns || 80,
          color: terminalColors(options.color, true, env),
        },
      } : {}),
      readDiff: (finding, revisions) => diffReader.read(finding, revisions),
    })));
    const start = performance.now();
    timer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, options.environment.runTimeout.milliseconds);
    const application = new ReviewApplication({
      source: new GitRevisionSource(options, env, destination), reporter,
      prepareContext: async (capture, contextSignal) => {
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
        signal.throwIfAborted();
        const remaining = Math.max(1, Math.floor(options.environment.runTimeout.milliseconds - (performance.now() - start)));
        return executePreparedReview({ ...input,
          environment: { ...input.environment, runTimeout: { minutes: remaining / 60_000, milliseconds: remaining } },
          executor: {
            harness: executor.harness,
            prepare: (settings) => { signal.throwIfAborted(); return executor.prepare(settings); },
            execute: (prepared, prompt, executeOptions) => { signal.throwIfAborted(); return executor.execute(prepared, prompt, executeOptions); },
          },
        });
      },
    });
    const result = await application.run({ environment: { ...options.environment, outputDirectory: destination } }, signal);
    const incomplete = result.summary.omittedFiles > 0 || ['incomplete', 'unavailable'].includes(result.review.coverage.files.status);
    let code = incomplete ? 1 : result.exitCode;
    if (code === 0 && options.failOn !== 'none') {
      const severities = options.failOn === 'critical' ? ['critical'] : options.failOn === 'high' ? ['critical', 'high'] : ['critical', 'high', 'medium', 'low'];
      if (result.review.findings.some((finding) => severities.includes(finding.severity))) code = 3;
    }
    if (reporter.failures.size > 0) code = 5;
    await writeFile(join(destination, 'status.json'), `${JSON.stringify({ version: 1, status: code === 0 || code === 3 ? 'completed' : 'incomplete', exitCode: code, ...(options.environment.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.environment.maxOutputTokens }), reporterFailures: [...reporter.failures] }, null, 2)}\n`);
    return code;
  } catch (error) {
    if (error instanceof LocalOperationError) stderr(`redline: ${terminalText(error.message, options.environment.credential?.value)}`);
    const status = signal.aborted ? deadlineExpired ? 'deadline-exhausted' : 'cancelled' : 'failed';
    const code = status === 'cancelled' ? 130 : 1;
    stderr(`redline: ${status}; ${output === undefined ? 'no output created' : `partial artifacts: ${terminalText(output, options.environment.credential?.value)}`}`);
    if (output !== undefined) await writeFile(join(output, 'status.json'), `${JSON.stringify({ version: 1, status, exitCode: code })}\n`).catch(() => undefined);
    return code;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
