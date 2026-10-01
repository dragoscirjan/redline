import { validateDigestPinnedImage } from './container-staging.js';
import type { ContainerEngine } from './backend-process.js';
import { parseDuration, type Duration } from './duration.js';
import {
  parseFirstRunnableReviewConfiguration,
  selectDirectModelCredential,
  type FirstRunnableReviewConfiguration,
  type SelectedModelCredential,
} from './review-configuration.js';

/**
 * The full GitHub composite action input surface. Every value arrives as a
 * string; validation here is authoritative. No input accepts free-form review
 * instructions — inputs configure the fixed versioned review policy.
 */
export interface CompositeActionInputs {
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
}

export interface ParsedCompositeActionInputs {
  readonly configuration: FirstRunnableReviewConfiguration;
  readonly credential: SelectedModelCredential;
  readonly timeout: Duration;
  readonly runnerImage: string;
  readonly containerEngine: ContainerEngine;
  readonly artifactName: string;
  readonly artifactRetentionDays: number;
}

export const DEFAULT_TIMEOUT_INPUT = '30m';
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 45;
export const MAX_ARTIFACT_RETENTION_DAYS = 90;
export const MAX_TIMEOUT_MINUTES = 360;

const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

function required(raw: string, label: string): string {
  if (raw.length === 0) throw new Error(`${label} is required`);
  return raw;
}

function boundedChoice<T extends string>(raw: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(raw as T)) throw new Error(`${label} is unsupported`);
  return raw as T;
}

function positiveBoundedInteger(raw: string, maximum: number, label: string): number {
  if (!/^[0-9]+$/u.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function boundedName(raw: string, label: string): string {
  if (raw.length === 0 || raw !== raw.trim() || !ARTIFACT_NAME_PATTERN.test(raw)) {
    throw new Error(`${label} is invalid`);
  }
  return raw;
}

export function parseCompositeActionInputs(input: CompositeActionInputs): ParsedCompositeActionInputs {
  const configuration = parseFirstRunnableReviewConfiguration({
    backend: input.backend,
    modelConfig: input.modelConfig,
    credentialIsolation: input.credentialIsolation,
    findingScope: input.findingScope.length === 0 ? undefined : input.findingScope,
    reportStyle: input.reportStyle.length === 0 ? undefined : input.reportStyle,
  });

  const credential = selectDirectModelCredential(
    configuration,
    required(input.modelAuth, 'model-auth'),
    'model-auth',
  );
  const timeout = parseDuration(
    input.timeout.length === 0 ? DEFAULT_TIMEOUT_INPUT : input.timeout,
    { maximumMinutes: MAX_TIMEOUT_MINUTES },
  );
  const runnerImage = required(input.runnerImage, 'runner-image');
  validateDigestPinnedImage(runnerImage);
  const containerEngine = boundedChoice(input.containerEngine, ['podman', 'docker'] as const, 'container engine');
  const artifactName = boundedName(input.artifactName, 'artifact-name');
  const artifactRetentionDays = positiveBoundedInteger(
    input.artifactRetentionDays.length === 0 ? String(DEFAULT_ARTIFACT_RETENTION_DAYS) : input.artifactRetentionDays,
    MAX_ARTIFACT_RETENTION_DAYS,
    'artifact-retention-days',
  );

  return Object.freeze({
    configuration,
    credential,
    timeout,
    runnerImage,
    containerEngine,
    artifactName,
    artifactRetentionDays,
  });
}
