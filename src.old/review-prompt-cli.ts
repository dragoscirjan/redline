#!/usr/bin/env node

import { assembleReviewPrompt, type ReviewPromptOptions } from './review-prompt.js';

const USAGE = `Usage: redline-review-prompt assemble --review-dir <path> --source-dir <path> --inspection read-only [options]

Options:
  --finding-scope <defects|defects-and-risks>           Default: defects
  --vulnerability-checks <off|changed-dependencies>    Default: off
  --vulnerability-tool <available|unavailable>         Default: unavailable
  --reporting <events>                                  Default: events
  --report-style <single-block|inline>                  Default: single-block
  --subagents <available|unavailable>                   Default: unavailable
  --help
`;

function optionValue(arguments_: string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments(arguments_: string[]): ReviewPromptOptions | 'help' {
  if (arguments_.length === 0 || arguments_.includes('--help')) return 'help';
  const command = arguments_[0];
  if (command !== 'assemble') throw new Error(`unsupported command: ${command}`);

  const values = new Map<string, string>();
  const supported = new Set([
    '--review-dir',
    '--source-dir',
    '--inspection',
    '--finding-scope',
    '--vulnerability-checks',
    '--vulnerability-tool',
    '--reporting',
    '--report-style',
    '--subagents',
  ]);
  for (let index = 1; index < arguments_.length; index += 2) {
    const option = arguments_[index] as string;
    if (!supported.has(option)) throw new Error(`unsupported option: ${option}`);
    if (values.has(option)) throw new Error(`option repeated: ${option}`);
    values.set(option, optionValue(arguments_, index, option));
  }

  const reviewDirectory = values.get('--review-dir');
  const sourceDirectory = values.get('--source-dir');
  if (!reviewDirectory || !sourceDirectory) throw new Error('--review-dir and --source-dir are required');
  const inspection = values.get('--inspection');
  if (inspection !== 'read-only') throw new Error('--inspection read-only is required');

  const findingScope = values.get('--finding-scope');
  const vulnerabilityChecks = values.get('--vulnerability-checks');
  const vulnerabilityTool = values.get('--vulnerability-tool');
  const reporting = values.get('--reporting');
  const reportStyle = values.get('--report-style');
  const subagents = values.get('--subagents');
  return {
    reviewDirectory,
    sourceDirectory,
    inspection,
    ...(findingScope ? { findingScope: findingScope as NonNullable<ReviewPromptOptions['findingScope']> } : {}),
    ...(vulnerabilityChecks
      ? { vulnerabilityChecks: vulnerabilityChecks as NonNullable<ReviewPromptOptions['vulnerabilityChecks']> }
      : {}),
    ...(vulnerabilityTool
      ? { vulnerabilityTool: vulnerabilityTool as NonNullable<ReviewPromptOptions['vulnerabilityTool']> }
      : {}),
    ...(reporting ? { reporting: reporting as NonNullable<ReviewPromptOptions['reporting']> } : {}),
    ...(reportStyle ? { reportStyle: reportStyle as NonNullable<ReviewPromptOptions['reportStyle']> } : {}),
    ...(subagents ? { subagents: subagents as NonNullable<ReviewPromptOptions['subagents']> } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const result = await assembleReviewPrompt(options);
  process.stdout.write(result.prompt);
  process.stderr.write(
    `Redline review prompt: policy=${result.policyDigest} prompt=${result.promptDigest} files=${result.fileCount} base=${result.base} head=${result.head}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`redline-review-prompt: ${message}\n`);
  process.exitCode = 2;
});
