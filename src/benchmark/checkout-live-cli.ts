#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCheckoutBenchmarkProfile } from './checkout.ts';
import { runCheckoutBenchmark } from './checkout-live.ts';

function runUrl(): string {
  const repository = process.env['GITHUB_REPOSITORY'];
  const runId = process.env['GITHUB_RUN_ID'];
  if (repository === undefined || runId === undefined) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_RUN_ID are required');
  }
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.length !== 2) {
    process.stderr.write('Usage: checkout-live-cli <profile.json> <output-directory>\n');
    return 2;
  }
  try {
    const profile = await loadCheckoutBenchmarkProfile(resolve(args[0] as string));
    await runCheckoutBenchmark(profile, {
      outputDirectory: resolve(args[1] as string),
      runUrl: runUrl(),
      runnerOs: process.env['RUNNER_OS'] ?? process.platform,
      architecture: process.arch,
      progress: (message) => process.stdout.write(`${message}\n`),
    });
    return 0;
  } catch (error) {
    process.stderr.write(`checkout-live-benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
