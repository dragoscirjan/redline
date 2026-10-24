#!/usr/bin/env node

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBenchmarkCorpus } from './benchmark.ts';
import {
  buildModelExecutionReport,
  captureModelExecution,
  loadModelExecutionCapture,
  writeModelExecutionArtifacts,
  type ModelTokenPricing,
} from './model-execution.ts';
import { parseModelConfig, selectModelCredential } from '../review/environment.ts';

interface ParsedArguments {
  readonly command: 'capture' | 'report';
  readonly corpusDirectory: string;
  readonly captureFile: string;
  readonly outputJson?: string | undefined;
  readonly outputMarkdown?: string | undefined;
  readonly pricing?: ModelTokenPricing | undefined;
}

function positiveNumber(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const command = args[0];
  if (command !== 'capture' && command !== 'report') {
    throw new Error('first argument must be capture or report');
  }
  let corpusDirectory = 'benchmark/review-quality/v2';
  let captureFile: string | undefined;
  let outputJson: string | undefined;
  let outputMarkdown: string | undefined;
  let inputPrice: string | undefined;
  let outputPrice: string | undefined;
  let cacheReadPrice: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (!['--corpus', '--capture', '--output-json', '--output-markdown', '--input-price', '--output-price', '--cache-read-price'].includes(argument ?? '')) {
      throw new Error(`unsupported argument: ${argument ?? ''}`);
    }
    if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
    if (argument === '--corpus') corpusDirectory = value;
    else if (argument === '--capture') captureFile = value;
    else if (argument === '--output-json') outputJson = value;
    else if (argument === '--output-markdown') outputMarkdown = value;
    else if (argument === '--input-price') inputPrice = value;
    else if (argument === '--output-price') outputPrice = value;
    else cacheReadPrice = value;
    index += 1;
  }
  if (captureFile === undefined) throw new Error('--capture is required');
  if (command === 'report' && (outputJson === undefined || outputMarkdown === undefined)) {
    throw new Error('report requires --output-json and --output-markdown');
  }
  const pricing = command === 'capture' ? {
    inputUsdPerToken: positiveNumber(inputPrice, '--input-price'),
    outputUsdPerToken: positiveNumber(outputPrice, '--output-price'),
    cacheReadUsdPerToken: positiveNumber(cacheReadPrice, '--cache-read-price'),
  } : undefined;
  return {
    command,
    corpusDirectory: resolve(corpusDirectory),
    captureFile: resolve(captureFile),
    ...(outputJson === undefined ? {} : { outputJson: resolve(outputJson) }),
    ...(outputMarkdown === undefined ? {} : { outputMarkdown: resolve(outputMarkdown) }),
    ...(pricing === undefined ? {} : { pricing }),
  };
}

async function writeCapture(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const options = parseArguments(args);
    if (options.command === 'capture') {
      if (environment.REDLINE_LIVE_BENCHMARK !== '1') {
        throw new Error('set REDLINE_LIVE_BENCHMARK=1 to run live model execution capture');
      }
      const model = parseModelConfig(environment.REDLINE_MODEL_CONFIG ?? '');
      const credential = model.auth === 'none'
        ? undefined
        : selectModelCredential(model, environment.REDLINE_MODEL_AUTH ?? '');
      const capture = await captureModelExecution({
        corpusDirectory: options.corpusDirectory,
        model,
        credential,
        pricing: options.pricing as ModelTokenPricing,
      });
      await writeCapture(options.captureFile, capture);
      process.stdout.write(`${options.captureFile}\n`);
      return 0;
    }

    const [capture, corpus] = await Promise.all([
      loadModelExecutionCapture(options.captureFile),
      loadBenchmarkCorpus(options.corpusDirectory),
    ]);
    const report = buildModelExecutionReport(capture, corpus.fixtures);
    await writeModelExecutionArtifacts(
      options.outputJson as string,
      options.outputMarkdown as string,
      report,
    );
    process.stdout.write(`${options.outputJson}\n${options.outputMarkdown}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`redline-model-execution: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await main();
