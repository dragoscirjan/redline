#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CapabilityError } from '../application/capabilities.ts';
import { CompositeReporter } from '../application/review.ts';
import { HELP, parseLocalOptions, UsageError } from './options.ts';
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
  try {
    const result = await runLocalReview(options, env, {
      signal, stdout, stderr,
      reporter: (destination) => {
        const diffReader = new FindingDiffReader(join(destination, 'bundle'), join(destination, 'source'));
        return new CompositeReporter(options.reporters.map(() => new CliReporter(stdout, stderr, options.environment.credential?.value, {
          color: terminalColors(options.color, dependencies.stdout === undefined && process.stdout.isTTY === true, env),
          ...(dependencies.stderr === undefined && process.stderr.isTTY === true && env.TERM !== 'dumb' ? {
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
