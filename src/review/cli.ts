#!/usr/bin/env node
/**
 * Review tool command-line entry point.
 *
 * Runs standalone (`redline-review`) and as the GitHub Action component: the
 * action sets the `REDLINE_*` environment contract and invokes this CLI
 * twice — first with `--validate-only` for authoritative input validation,
 * then for the review run itself.
 */

import { pathToFileURL } from 'node:url';
import { parseReviewEnvironment } from './environment.js';
import { runFileReviews } from './runner.js';

const USAGE_ERROR_EXIT = 2;
const RUN_FAILURE_EXIT = 1;

function writeLine(stream: NodeJS.WriteStream, value: string): void {
  stream.write(`${value}\n`);
}

export async function main(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const validateOnly = arguments_.includes('--validate-only');
  if (arguments_.some((argument) => argument !== '--validate-only')) {
    writeLine(process.stderr, 'redline-review: unsupported argument (only --validate-only is accepted)');
    return USAGE_ERROR_EXIT;
  }

  let parsed;
  try {
    parsed = parseReviewEnvironment(environment);
  } catch (error) {
    writeLine(process.stderr, `redline-review: ${error instanceof Error ? error.message : String(error)}`);
    return validateOnly ? USAGE_ERROR_EXIT : RUN_FAILURE_EXIT;
  }

  if (validateOnly) {
    writeLine(
      process.stdout,
      JSON.stringify(
        parsed.mode === 'review'
          ? { mode: 'review', harness: parsed.review?.harness, timeoutMinutes: parsed.timeout.minutes }
          : { mode: 'context-only', timeoutMinutes: parsed.timeout.minutes },
      ),
    );
    return 0;
  }

  if (parsed.mode === 'context-only') {
    writeLine(process.stdout, JSON.stringify({ mode: 'context-only' }));
    return 0;
  }

  try {
    const result = await runFileReviews({ environment: parsed.review as NonNullable<typeof parsed.review> });
    writeLine(process.stdout, JSON.stringify(result.summary));
    return result.exitCode;
  } catch (error) {
    writeLine(process.stderr, `redline-review: ${error instanceof Error ? error.message : String(error)}`);
    return RUN_FAILURE_EXIT;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main().then((code) => {
    process.exit(code);
  });
}
