#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runRecordedBenchmark, writeBenchmarkReport } from './benchmark.js';

interface CliOptions {
  readonly corpusDirectory: string;
  readonly outputDirectory: string;
}

function parseArguments(args: readonly string[]): CliOptions {
  let corpusDirectory = 'benchmark/review-quality/v2';
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--corpus' && argument !== '--output') {
      throw new Error(`unsupported argument: ${argument ?? ''}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
    if (argument === '--corpus') corpusDirectory = value;
    else outputDirectory = value;
    index += 1;
  }
  const corpus = resolve(corpusDirectory);
  return {
    corpusDirectory: corpus,
    outputDirectory: resolve(outputDirectory ?? `${corpus}/comparison`),
  };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArguments(args);
    const report = await runRecordedBenchmark(options.corpusDirectory);
    await writeBenchmarkReport(report, options.outputDirectory);
    process.stdout.write(`${options.outputDirectory}/report.json\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`redline-benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await main();
