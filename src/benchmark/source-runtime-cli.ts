#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORT_VERSION = 1 as const;
const STARTUP_RUNS = 5;
const REVIEW_RUNS = 3;
const MAX_OUTPUT_BYTES = 64 * 1024;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type SourceRuntime = 'node' | 'bun';

interface Options {
  readonly runtime: SourceRuntime;
  readonly json: string;
  readonly markdown: string;
}

interface Distribution {
  readonly samples: number;
  readonly minimum: number;
  readonly p50NearestRank: number;
  readonly p95NearestRank: number;
  readonly maximum: number;
}

function parseOptions(args: readonly string[]): Options {
  let runtime: SourceRuntime = 'node';
  let json: string | undefined;
  let markdown: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`missing value for ${argument ?? 'argument'}`);
    if (argument === '--runtime') {
      if (value !== 'node' && value !== 'bun') throw new Error('--runtime must be node or bun');
      runtime = value;
    } else if (argument === '--json') {
      json = resolve(value);
    } else if (argument === '--markdown') {
      markdown = resolve(value);
    } else {
      throw new Error(`unsupported argument: ${argument}`);
    }
    index += 1;
  }
  const outputRoot = resolve('benchmark/source-runtime/v1');
  return {
    runtime,
    json: json ?? resolve(outputRoot, `${runtime}.json`),
    markdown: markdown ?? resolve(outputRoot, `${runtime}.md`),
  };
}

function boundedDiagnostic(value: string): string {
  return value.slice(-2_000).replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/gu, ' ');
}

function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv, timeout: number): string {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    env: environment,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? 'without status'}: ${boundedDiagnostic(result.stderr)}`);
  }
  return result.stdout.trim();
}

function elapsedMs(runCommand: () => void): number {
  const started = process.hrtime.bigint();
  runCommand();
  return Number((process.hrtime.bigint() - started) / 1_000_000n);
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) throw new Error('runtime benchmark requires samples');
  const sorted = [...values].sort((left, right) => left - right);
  const nearest = (percentile: number): number => sorted[Math.ceil(sorted.length * percentile) - 1]!;
  return {
    samples: sorted.length,
    minimum: sorted[0]!,
    p50NearestRank: nearest(0.5),
    p95NearestRank: nearest(0.95),
    maximum: sorted.at(-1)!,
  };
}

function measure(runtime: SourceRuntime): Record<string, unknown> {
  const version = run(runtime, ['--version'], process.env, 30_000);
  if (runtime === 'node' && !/^v24\./u.test(version)) throw new Error(`Node 24 is required, received ${version}`);
  if (runtime === 'bun' && version !== '1.4.4') throw new Error(`Bun 1.4.4 is required, received ${version}`);

  const startupSamples = Array.from({ length: STARTUP_RUNS }, () => elapsedMs(() => {
    run(runtime, ['src/review/cli.ts', '--validate-only'], {
      ...process.env,
      REDLINE_FINDING_SCOPE: 'defects',
    }, 30_000);
  }));
  const reviewSamples = Array.from({ length: REVIEW_RUNS }, () => elapsedMs(() => {
    run('bash', ['test/harness-matrix-run.sh', 'echo'], {
      ...process.env,
      SOURCE_RUNTIME: runtime,
    }, 120_000);
  }));

  return {
    version: REPORT_VERSION,
    capturedAt: new Date().toISOString(),
    runtime,
    runtimeVersion: version,
    environment: { platform: platform(), architecture: arch() },
    startupMs: distribution(startupSamples),
    echoReviewMs: distribution(reviewSamples),
    samples: { startupMs: startupSamples, echoReviewMs: reviewSamples },
    limits: [
      'Local process measurements include operating-system and filesystem noise.',
      'The echo review measures direct-source bundle and review execution without model or network latency.',
      'The result does not show that Bun improves model-bound review latency.',
    ],
  };
}

function render(report: Record<string, unknown>): string {
  const startup = report['startupMs'] as Distribution;
  const review = report['echoReviewMs'] as Distribution;
  const environment = report['environment'] as { readonly platform: string; readonly architecture: string };
  return [
    '# TypeScript source runtime benchmark',
    '',
    `- Runtime: ${report['runtime']} ${report['runtimeVersion']}`,
    `- Captured: ${report['capturedAt']}`,
    `- Environment: ${environment.platform}/${environment.architecture}`,
    '',
    '| Measurement | Runs | Minimum | p50 | p95 | Maximum |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| CLI validation startup | ${startup.samples} | ${startup.minimum} ms | ${startup.p50NearestRank} ms | ${startup.p95NearestRank} ms | ${startup.maximum} ms |`,
    `| Echo review pipeline | ${review.samples} | ${review.minimum} ms | ${review.p50NearestRank} ms | ${review.p95NearestRank} ms | ${review.maximum} ms |`,
    '',
    '## Limits',
    '',
    ...(report['limits'] as readonly string[]).map((item) => `- ${item}`),
    '',
  ].join('\n');
}

try {
  const options = parseOptions(process.argv.slice(2));
  const report = measure(options.runtime);
  mkdirSync(dirname(options.json), { recursive: true });
  mkdirSync(dirname(options.markdown), { recursive: true });
  writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(options.markdown, render(report));
  process.stdout.write(`${options.json}\n${options.markdown}\n`);
} catch (error) {
  process.stderr.write(`source runtime benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
