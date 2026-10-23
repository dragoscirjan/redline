#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDuration } from '../duration.js';
import { createHarnessExecutor, isHarnessName } from '../harness-executor/registry.js';
import { parseModelConfig, selectModelCredential } from '../review/environment.js';
import {
  runPerformanceBenchmark,
  writePerformanceReport,
  type LivePerformanceConfiguration,
  type PerformanceSource,
} from './performance.js';

interface CliOptions {
  readonly corpusPath: string;
  readonly profilePath: string;
  readonly outputDirectory: string;
  readonly runs: number;
  readonly source: PerformanceSource;
}

function parseRuns(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error('--runs must be a positive integer');
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('--runs must be an integer from 1 through 20');
  }
  return parsed;
}

function parseArguments(args: readonly string[]): CliOptions {
  let corpusPath = 'benchmark/performance/v1/corpus.json';
  let profilePath = 'benchmark/performance/v1/profile.json';
  let outputDirectory: string | undefined;
  let runs = 1;
  let source: PerformanceSource = 'recorded';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--live') {
      source = 'live';
      continue;
    }
    if (argument !== '--corpus' && argument !== '--profile' && argument !== '--output' && argument !== '--runs') {
      throw new Error(`unsupported argument: ${argument ?? ''}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
    if (argument === '--corpus') corpusPath = value;
    else if (argument === '--profile') profilePath = value;
    else if (argument === '--output') outputDirectory = value;
    else runs = parseRuns(value);
    index += 1;
  }
  if (source === 'live' && outputDirectory === undefined) {
    throw new Error('--output is required for live performance captures');
  }
  return {
    corpusPath: resolve(corpusPath),
    profilePath: resolve(profilePath),
    outputDirectory: resolve(outputDirectory ?? 'benchmark/performance/v1/baseline'),
    runs,
    source,
  };
}

function liveConfiguration(environment: NodeJS.ProcessEnv): LivePerformanceConfiguration {
  if (environment.REDLINE_LIVE_BENCHMARK !== '1') {
    throw new Error('set REDLINE_LIVE_BENCHMARK=1 for live performance capture');
  }
  const harness = environment.REDLINE_HARNESS ?? '';
  if (!isHarnessName(harness) || harness === 'echo') {
    throw new Error('REDLINE_HARNESS must select pi or opencode for live performance capture');
  }
  const model = parseModelConfig(environment.REDLINE_MODEL_CONFIG ?? '');
  return {
    harness,
    model,
    credential: selectModelCredential(model, environment.REDLINE_MODEL_AUTH ?? ''),
    timeout: parseDuration(environment.REDLINE_TIMEOUT ?? '30m'),
    executorFactory: () => createHarnessExecutor(harness),
  };
}

export function performanceExitCode(report: { readonly quality: { readonly passed: boolean } }): number {
  return report.quality.passed ? 0 : 1;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const options = parseArguments(args);
    const report = await runPerformanceBenchmark({
      corpusPath: options.corpusPath,
      profilePath: options.profilePath,
      source: options.source,
      runs: options.runs,
      ...(options.source === 'live' ? { live: liveConfiguration(environment) } : {}),
    });
    await writePerformanceReport(report, options.outputDirectory);
    process.stdout.write(`${options.outputDirectory}/report.json\n`);
    return performanceExitCode(report);
  } catch (error) {
    process.stderr.write(`redline-performance-benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await main();
