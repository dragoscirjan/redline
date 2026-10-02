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

const KNOWN_INPUT_KEYS: ReadonlySet<string> = new Set([
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
]);

const REVIEW_SELECTION_KEYS = ['backend', 'modelConfig', 'modelAuth', 'runnerImage'] as const;

export type ReviewMode = 'context-only' | 'review';

export interface ParsedCompositeActionInputs {
  readonly configuration: FirstRunnableReviewConfiguration;
  readonly credential: SelectedModelCredential;
  readonly timeout: Duration;
  readonly runnerImage: string;
  readonly containerEngine: ContainerEngine;
  readonly artifactName: string;
  readonly artifactRetentionDays: number;
}

export interface ParsedContextOnlyInputs {
  readonly timeout: Duration;
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

function optionalChoice<T extends string>(raw: string, allowed: readonly T[], label: string): T | undefined {
  if (raw.length === 0) return undefined;
  if (!allowed.includes(raw as T)) throw new Error(`${label} is unsupported`);
  return raw as T;
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

function rejectUnknownInputs(input: CompositeActionInputs & { readonly [key: string]: unknown }): void {
  for (const key of Object.keys(input)) {
    if (!KNOWN_INPUT_KEYS.has(key)) throw new Error(`unknown action input: ${key}`);
  }
}

export function parseTimeout(input: CompositeActionInputs): Duration {
  return parseDuration(input.timeout.length === 0 ? DEFAULT_TIMEOUT_INPUT : input.timeout, {
    maximumMinutes: MAX_TIMEOUT_MINUTES,
  });
}

export function parseArtifactSettings(input: CompositeActionInputs): {
  containerEngine: ContainerEngine;
  artifactName: string;
  artifactRetentionDays: number;
} {
  return {
    containerEngine: boundedChoice(input.containerEngine, ['podman', 'docker'] as const, 'container engine'),
    artifactName: boundedName(input.artifactName, 'artifact-name'),
    artifactRetentionDays: positiveBoundedInteger(
      input.artifactRetentionDays.length === 0 ? String(DEFAULT_ARTIFACT_RETENTION_DAYS) : input.artifactRetentionDays,
      MAX_ARTIFACT_RETENTION_DAYS,
      'artifact-retention-days',
    ),
  };
}

/**
 * Determines whether the caller enabled review execution. Review inputs must
 * arrive together; a partial selection fails instead of silently degrading.
 */
export function reviewMode(input: CompositeActionInputs & { readonly [key: string]: unknown }): ReviewMode {
  rejectUnknownInputs(input);
  const provided = REVIEW_SELECTION_KEYS.filter((key) => (input[key] as string).length > 0);
  if (provided.length === 0) return 'context-only';
  if (provided.length < REVIEW_SELECTION_KEYS.length) {
    throw new Error('review execution requires backend, model-config, model-auth, and runner-image together');
  }
  return 'review';
}

/**
 * Validates the inputs that apply even when review execution is disabled, so
 * typos in optional inputs fail instead of passing silently.
 */
export function parseContextOnlyInputs(
  input: CompositeActionInputs & { readonly [key: string]: unknown },
): ParsedContextOnlyInputs {
  if (reviewMode(input) !== 'context-only') throw new Error('review inputs are supplied; this is not a context-only run');
  optionalChoice(input.findingScope, ['defects', 'defects-and-risks'] as const, 'finding scope');
  optionalChoice(input.reportStyle, ['single-block', 'inline'] as const, 'report style');
  optionalChoice(input.credentialIsolation, ['direct'] as const, 'credential-isolation');
  return Object.freeze({
    timeout: parseTimeout(input),
    ...parseArtifactSettings(input),
  });
}

export function parseCompositeActionInputs(
  input: CompositeActionInputs & { readonly [key: string]: unknown },
): ParsedCompositeActionInputs {
  if (reviewMode(input) !== 'review') throw new Error('review inputs are not enabled; this is a context-only run');

  const configuration = parseFirstRunnableReviewConfiguration({
    backend: input.backend,
    modelConfig: input.modelConfig,
    credentialIsolation: input.credentialIsolation.length === 0 ? undefined : input.credentialIsolation,
    findingScope: input.findingScope.length === 0 ? undefined : input.findingScope,
    reportStyle: input.reportStyle.length === 0 ? undefined : input.reportStyle,
  });

  const credential = selectDirectModelCredential(
    configuration,
    required(input.modelAuth, 'model-auth'),
    'model-auth',
  );
  const runnerImage = required(input.runnerImage, 'runner-image');
  validateDigestPinnedImage(runnerImage);

  return Object.freeze({
    configuration,
    credential,
    timeout: parseTimeout(input),
    runnerImage,
    ...parseArtifactSettings(input),
  });
}
