#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CapabilityError } from '../application/capabilities.ts';
import { CompositeReporter } from '../application/review.ts';
import { createReviewCommand, resolveLocalOptions, reviewOptionValues, UsageError } from './options.ts';
import { runLocalReview } from './run.ts';
import { FindingDiffReader } from './finding-diff.ts';
import { CliReporter, terminalColors } from './reporter.ts';

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
  const metadata: { version: string } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const program = new Command('redline')
    .description('Local Git code reviews')
    .version(`redline ${metadata.version}`)
    .addHelpCommand()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => stdout(text.trimEnd()),
      writeErr: () => {},
      outputError: () => {},
    })
    .action(() => { throw new UsageError('expected review; use --help'); });
  const review = createReviewCommand(program.command('review'));
  // Preserve the detailed root help without maintaining a second set of option descriptions.
  program.on('afterHelp', () => {
    stdout('');
    review.outputHelp();
    stdout('Use redline rpc --help for the stdio JSON-RPC command.');
  });
  let exitCode = 2;
  review.action(async () => {
    exitCode = await executeReview(reviewOptionValues(review), env, dependencies);
  });
  try {
    await program.parseAsync([...args], { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      stderr('redline: invalid arguments; use redline review --help (credentials are not command-line options)');
      return 2;
    }
    if (error instanceof UsageError) { stderr(`redline: ${error.message}`); return 2; }
    throw error;
  }
}

/** Resolve trusted options before execution, own interrupt handlers, and return classified failures without echoing raw argument values. */
async function executeReview(
  values: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
  dependencies: LocalCliDependencies,
): Promise<number> {
  const stdout = dependencies.stdout ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const stderr = dependencies.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  const interrupted = dependencies.signal ?? controller.signal;
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const signal = AbortSignal.any([interrupted, controller.signal]);
  let options;
  try { options = await resolveLocalOptions(values, env, dependencies.cwd ?? process.cwd(), signal); }
  catch (error) {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    // Parse errors are trusted classifications; never echo raw argument/config values.
    stderr(`redline: ${signal.aborted ? 'cancelled' : error instanceof CapabilityError || error instanceof UsageError ? error.message : 'invalid configuration or repository; use --help'}`);
    return signal.aborted ? 130 : error instanceof CapabilityError ? 4 : 2;
  }
  try {
    const result = await runLocalReview(options, env, {
      signal, stdout, stderr,
      reporter: (destination) => {
        const diffReader = new FindingDiffReader(join(destination, 'bundle'), join(destination, 'source'));
        return new CompositeReporter(options.reporters.map(() => new CliReporter(stdout, stderr, options.environment.credential?.value, {
          color: terminalColors(options.color, dependencies.stdout === undefined && process.stdout.isTTY === true, env),
          ...(dependencies.stderr === undefined && options.progress !== 'never'
            && (options.progress === 'always' || process.stderr.isTTY === true && env.TERM !== 'dumb') ? {
            terminal: {
              write: (text: string) => { process.stderr.write(text); }, columns: () => process.stderr.columns || 80,
              color: terminalColors(options.color, true, env),
            },
          } : {}),
          readDiff: (finding, revisions) => diffReader.read(finding, revisions),
        })));
      },
    });
    return result.exitCode;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
