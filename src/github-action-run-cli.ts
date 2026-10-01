#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GitHubReviewPublisher } from './github-review-publisher.js';
import { parseCompositeActionInputs, type ParsedCompositeActionInputs } from './action-inputs.js';
import { createContainerStagingLauncher } from './container-staging.js';
import type { ContainerEngine } from './backend-process.js';
import { runReview, type ReviewRunIdentity, type ReviewRunResult } from './review-run.js';
import type { FindingScope, ReportStyle } from './review-prompt.js';

/**
 * Trusted host-side entry point for the GitHub composite action.
 *
 * Inputs arrive through explicit REDLINE_* environment variables; nothing is
 * read from the ambient environment except GH_TOKEN, which stays in host
 * publication code and never enters the container.
 */

export interface ActionEnvironment {
  readonly githubToken: string;
  readonly backend: string;
  readonly modelConfig: string;
  readonly modelAuth: string;
  readonly findingScope: string;
  readonly reportStyle: string;
  readonly timeout: string;
  readonly credentialIsolation: string;
  readonly runnerImage: string;
  readonly containerEngine: string;
  readonly artifactName: string;
  readonly artifactRetentionDays: string;
  readonly reviewDirectory: string;
  readonly sourceDirectory: string;
  readonly journalPath: string;
  readonly runId: string;
  readonly repository: string;
  readonly pullRequest: string;
  readonly base: string;
  readonly head: string;
}

export interface ParsedActionEnvironment {
  readonly parsed: ParsedCompositeActionInputs;
  readonly reviewDirectory: string;
  readonly sourceDirectory: string;
  readonly journalPath: string;
  readonly identity: ReviewRunIdentity;
}

const ACTION_ENVIRONMENT_KEYS = [
  'backend',
  'modelConfig',
  'modelAuth',
  'findingScope',
  'reportStyle',
  'timeout',
  'credentialIsolation',
  'runnerImage',
  'containerEngine',
  'artifactName',
  'artifactRetentionDays',
  'reviewDirectory',
  'sourceDirectory',
  'journalPath',
  'runId',
  'repository',
  'pullRequest',
  'base',
  'head',
] as const;

const ACTION_ENVIRONMENT_VARIABLES: Record<(typeof ACTION_ENVIRONMENT_KEYS)[number], string> = {
  backend: 'REDLINE_BACKEND',
  modelConfig: 'REDLINE_MODEL_CONFIG',
  modelAuth: 'REDLINE_MODEL_AUTH',
  findingScope: 'REDLINE_FINDING_SCOPE',
  reportStyle: 'REDLINE_REPORT_STYLE',
  timeout: 'REDLINE_TIMEOUT',
  credentialIsolation: 'REDLINE_CREDENTIAL_ISOLATION',
  runnerImage: 'REDLINE_RUNNER_IMAGE',
  containerEngine: 'REDLINE_CONTAINER_ENGINE',
  artifactName: 'REDLINE_ARTIFACT_NAME',
  artifactRetentionDays: 'REDLINE_ARTIFACT_RETENTION_DAYS',
  reviewDirectory: 'REDLINE_REVIEW_DIR',
  sourceDirectory: 'REDLINE_SOURCE_DIR',
  journalPath: 'REDLINE_JOURNAL_PATH',
  runId: 'REDLINE_RUN_ID',
  repository: 'REDLINE_REPOSITORY',
  pullRequest: 'REDLINE_PULL_REQUEST',
  base: 'REDLINE_BASE',
  head: 'REDLINE_HEAD',
};

function environmentValue(environment: ActionEnvironment, key: (typeof ACTION_ENVIRONMENT_KEYS)[number]): string {
  const value = (environment as unknown as Record<string, unknown>)[key];
  if (typeof value !== 'string') throw new Error(`${ACTION_ENVIRONMENT_VARIABLES[key]} is required`);
  return value;
}

function noNul(value: string, label: string): string {
  if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`);
  return value;
}

export function parseActionEnvironment(environment: ActionEnvironment): ParsedActionEnvironment {
  const githubTokenRaw = (environment as unknown as Record<string, unknown>).githubToken;
  if (typeof githubTokenRaw !== 'string' || githubTokenRaw.length === 0 || githubTokenRaw.includes('\0')) {
    throw new Error('GH_TOKEN is required');
  }
  const githubToken = githubTokenRaw;

  const values = new Map<string, string>();
  for (const key of ACTION_ENVIRONMENT_KEYS) {
    values.set(key, noNul(environmentValue(environment, key), ACTION_ENVIRONMENT_VARIABLES[key]));
  }

  const get = (key: (typeof ACTION_ENVIRONMENT_KEYS)[number]): string => values.get(key) as string;

  const parsed = parseCompositeActionInputs({
    backend: get('backend'),
    modelConfig: get('modelConfig'),
    modelAuth: get('modelAuth'),
    findingScope: get('findingScope'),
    reportStyle: get('reportStyle'),
    timeout: get('timeout'),
    credentialIsolation: get('credentialIsolation'),
    runnerImage: get('runnerImage'),
    containerEngine: get('containerEngine'),
    artifactName: get('artifactName'),
    artifactRetentionDays: get('artifactRetentionDays'),
  });

  const pullRequest = Number(get('pullRequest'));
  if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) {
    throw new Error('pull request number must be a positive integer');
  }

  return {
    parsed,
    reviewDirectory: get('reviewDirectory'),
    sourceDirectory: get('sourceDirectory'),
    journalPath: get('journalPath'),
    identity: {
      runId: get('runId'),
      repository: get('repository'),
      pullRequest,
      base: get('base').toLowerCase(),
      head: get('head').toLowerCase(),
      reportStyle: parsed.configuration.reportStyle as ReportStyle,
    },
  };
}

export interface ActionExecutionInput extends ParsedActionEnvironment {
  readonly githubToken: string;
  readonly findingScope: FindingScope;
  readonly containerEngine: ContainerEngine;
}

export async function executeAction(input: ActionExecutionInput): Promise<ReviewRunResult> {
  const publisher = new GitHubReviewPublisher({ token: input.githubToken });
  const launcher = createContainerStagingLauncher({
    engine: input.containerEngine,
    image: input.parsed.runnerImage,
    reviewDirectory: input.reviewDirectory,
    sourceDirectory: input.sourceDirectory,
    configuration: input.parsed.configuration,
    credential: input.parsed.credential,
  });
  return runReview({
    backend: input.parsed.configuration.backend,
    reviewDirectory: input.reviewDirectory,
    sourceDirectory: input.sourceDirectory,
    journalPath: input.journalPath,
    findingScope: input.findingScope,
    identity: input.identity,
    timeoutMs: input.parsed.timeout.milliseconds,
    publisher,
    launcher,
  });
}

export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  const actionEnvironment: ActionEnvironment = {
    githubToken: environment.GH_TOKEN ?? '',
    backend: environment.REDLINE_BACKEND ?? '',
    modelConfig: environment.REDLINE_MODEL_CONFIG ?? '',
    modelAuth: environment.REDLINE_MODEL_AUTH ?? '',
    findingScope: environment.REDLINE_FINDING_SCOPE ?? '',
    reportStyle: environment.REDLINE_REPORT_STYLE ?? '',
    timeout: environment.REDLINE_TIMEOUT ?? '',
    credentialIsolation: environment.REDLINE_CREDENTIAL_ISOLATION ?? '',
    runnerImage: environment.REDLINE_RUNNER_IMAGE ?? '',
    containerEngine: environment.REDLINE_CONTAINER_ENGINE ?? '',
    artifactName: environment.REDLINE_ARTIFACT_NAME ?? '',
    artifactRetentionDays: environment.REDLINE_ARTIFACT_RETENTION_DAYS ?? '',
    reviewDirectory: environment.REDLINE_REVIEW_DIR ?? '',
    sourceDirectory: environment.REDLINE_SOURCE_DIR ?? '',
    journalPath: environment.REDLINE_JOURNAL_PATH ?? '',
    runId: environment.REDLINE_RUN_ID ?? '',
    repository: environment.REDLINE_REPOSITORY ?? '',
    pullRequest: environment.REDLINE_PULL_REQUEST ?? '',
    base: environment.REDLINE_BASE ?? '',
    head: environment.REDLINE_HEAD ?? '',
  };

  let parsed: ParsedActionEnvironment;
  try {
    parsed = parseActionEnvironment(actionEnvironment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`redline-github-action: ${message}\n`);
    return 2;
  }

  try {
    const result = await executeAction({
      ...parsed,
      findingScope: parsed.parsed.configuration.findingScope,
      containerEngine: parsed.parsed.containerEngine,
      githubToken: actionEnvironment.githubToken,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'complete' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`redline-github-action: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
