#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createPreparedContainerLauncher,
  type ContainerEngine,
  type ReviewBackend,
} from './backend-process.js';
import { GitHubReviewPublisher } from './github-review-publisher.js';
import { runReview, type ReviewRunIdentity } from './review-run.js';
import type { FindingScope, ReportStyle } from './review-prompt.js';

const USAGE = `Usage: redline-review-run [options]

Required options:
  --backend <pi|opencode>
  --review-dir <path>
  --source-dir <path>
  --journal <path>
  --repository <owner/name>
  --pull-request <number>
  --base <full-object-id>
  --head <full-object-id>
  --run-id <id>
  --container-engine <podman|docker>
  --container-id <id>

Optional:
  --finding-scope <defects|defects-and-risks>    Default: defects
  --report-style <single-block|inline>           Default: single-block
  --timeout-seconds <1-7200>                     Default: 1200
  --opencode-session-id <id>                     Required for OpenCode
  --help

Environment:
  GH_TOKEN                                      Required GitHub publication token
`;

interface ReviewRunCliOptions {
  backend: ReviewBackend;
  reviewDirectory: string;
  sourceDirectory: string;
  journalPath: string;
  identity: ReviewRunIdentity;
  findingScope: FindingScope;
  timeoutMs: number;
  engine: ContainerEngine;
  containerId: string;
  opencodeSessionId?: string;
}

const SUPPORTED_OPTIONS = new Set([
  '--backend',
  '--review-dir',
  '--source-dir',
  '--journal',
  '--repository',
  '--pull-request',
  '--base',
  '--head',
  '--run-id',
  '--container-engine',
  '--container-id',
  '--finding-scope',
  '--report-style',
  '--timeout-seconds',
  '--opencode-session-id',
]);

function required(values: ReadonlyMap<string, string>, option: string): string {
  const value = values.get(option);
  if (!value) throw new Error(`${option} is required`);
  if (value.includes('\0')) throw new Error(`${option} contains a NUL byte`);
  return value;
}

function fixedValue<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${label} is unsupported`);
  return value as T;
}

function positiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

export function parseReviewRunArguments(arguments_: readonly string[]): ReviewRunCliOptions | 'help' {
  if (arguments_.includes('--help')) return 'help';
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    if (!option || !SUPPORTED_OPTIONS.has(option)) throw new Error(`unsupported option: ${option ?? ''}`);
    if (values.has(option)) throw new Error(`option repeated: ${option}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    values.set(option, value);
  }

  const backend = fixedValue(required(values, '--backend'), ['pi', 'opencode'], 'review backend');
  const engine = fixedValue(required(values, '--container-engine'), ['podman', 'docker'], 'container engine');
  const findingScope = fixedValue(
    values.get('--finding-scope') ?? 'defects',
    ['defects', 'defects-and-risks'],
    'finding scope',
  );
  const reportStyle = fixedValue(
    values.get('--report-style') ?? 'single-block',
    ['single-block', 'inline'],
    'report style',
  );
  const timeoutSeconds = positiveInteger(values.get('--timeout-seconds') ?? '1200', 'timeout seconds');
  if (timeoutSeconds > 7_200) throw new Error('timeout seconds exceeds 7200');
  const opencodeSessionId = values.get('--opencode-session-id');
  if (backend === 'opencode' && !opencodeSessionId) throw new Error('--opencode-session-id is required for OpenCode');
  if (backend === 'pi' && opencodeSessionId) throw new Error('--opencode-session-id is unsupported for Pi');

  return {
    backend,
    reviewDirectory: required(values, '--review-dir'),
    sourceDirectory: required(values, '--source-dir'),
    journalPath: required(values, '--journal'),
    identity: {
      runId: required(values, '--run-id'),
      repository: required(values, '--repository'),
      pullRequest: positiveInteger(required(values, '--pull-request'), 'pull request number'),
      base: required(values, '--base'),
      head: required(values, '--head'),
      reportStyle,
    },
    findingScope,
    timeoutMs: timeoutSeconds * 1_000,
    engine,
    containerId: required(values, '--container-id'),
    ...(opencodeSessionId ? { opencodeSessionId } : {}),
  };
}

async function execute(options: ReviewRunCliOptions, token: string): Promise<number> {
  const publisher = new GitHubReviewPublisher({ token });
  const launcher = createPreparedContainerLauncher({
    engine: options.engine,
    id: options.containerId,
    backend: options.backend,
    ...(options.opencodeSessionId ? { opencodeSessionId: options.opencodeSessionId } : {}),
  });
  const result = await runReview({
    backend: options.backend,
    reviewDirectory: options.reviewDirectory,
    sourceDirectory: options.sourceDirectory,
    journalPath: options.journalPath,
    findingScope: options.findingScope,
    identity: options.identity,
    timeoutMs: options.timeoutMs,
    publisher,
    launcher,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === 'complete' ? 0 : 1;
}

export async function main(
  arguments_ = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let options: ReviewRunCliOptions | 'help';
  try {
    options = parseReviewRunArguments(arguments_);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`redline-review-run: ${message}\n`);
    return 2;
  }
  if (options === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const token = environment.GH_TOKEN;
  if (!token) {
    process.stderr.write('redline-review-run: GH_TOKEN is required\n');
    return 2;
  }
  try {
    return await execute(options, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`redline-review-run: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
