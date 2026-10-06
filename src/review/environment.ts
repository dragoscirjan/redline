/**
 * Environment-variable contract between the GitHub Action and the review
 * tool (interim contract; a structured invocation API replaces it later).
 *
 * Parsing is authoritative and strict: unknown `REDLINE_*` variables are
 * rejected (typos fail loudly), review inputs must arrive together, and
 * every value is bounded and schema-checked. Optional values are validated
 * even in context-only mode so misconfiguration never passes silently.
 */

import { DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES, parseDuration, type Duration } from '../duration.js';
import { isHarnessName } from '../harness-executor/registry.js';
import type { HarnessName } from '../harness-executor/types.js';
import { FINDING_SCOPES, type FindingScope } from './types.js';

export const REDLINE_ENV_KEYS = [
  'REDLINE_HARNESS',
  'REDLINE_REVIEW_DIR',
  'REDLINE_SOURCE_DIR',
  'REDLINE_OUTPUT_DIR',
  'REDLINE_MODEL_CONFIG',
  'REDLINE_MODEL_AUTH',
  'REDLINE_FINDING_SCOPE',
  'REDLINE_TIMEOUT',
  'REDLINE_PUBLISH_TOKEN',
  'REDLINE_REPOSITORY',
  'REDLINE_PULL_REQUEST',
  'REDLINE_HEAD',
  'REDLINE_VERBOSITY',
] as const;

/** How much of the live model stream lands in the run log. */
export const VERBOSITIES = ['silent', 'progress', 'full-output'] as const;
export type ReviewVerbosity = (typeof VERBOSITIES)[number];
/** `progress` (dots) is the default: alive without flooding the log. */
export const DEFAULT_VERBOSITY: ReviewVerbosity = 'progress';

export const DEFAULT_TIMEOUT_INPUT = `${DEFAULT_TIMEOUT_MINUTES}m`;

const MAX_MODEL_CONFIG_BYTES = 16 * 1024;
const MAX_MODEL_CREDENTIALS_BYTES = 64 * 1024;
const MAX_SELECTED_CREDENTIAL_BYTES = 16 * 1024;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export type ReviewMode = 'context-only' | 'review';

export interface ModelConfiguration {
  readonly provider: string;
  readonly endpoint: string;
  readonly model: string;
}

export interface SelectedModelCredential {
  readonly provider: string;
  readonly value: string;
}

export interface ReviewEnvironment {
  readonly harness: HarnessName;
  readonly reviewDirectory: string;
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
  readonly model: ModelConfiguration;
  readonly credential: SelectedModelCredential;
  readonly findingScope: FindingScope;
  readonly timeout: Duration;
}

/**
 * Publication context. The token is normally the GH_TOKEN PAT; a GitHub App
 * installation token generated outside the workflow is consumed
 * identically. Absent means artifact-only mode.
 */
export interface PublicationEnvironment {
  readonly token: string;
  readonly repository: string;
  readonly pullRequest: number;
  readonly head: string;
}

export interface ParsedReviewEnvironment {
  readonly mode: ReviewMode;
  readonly timeout: Duration;
  readonly verbosity: ReviewVerbosity;
  readonly review: ReviewEnvironment | undefined;
  readonly publication: PublicationEnvironment | undefined;
}

type JsonObject = Record<string, unknown>;

function assertKnownEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (key.startsWith('REDLINE_') && !(REDLINE_ENV_KEYS as readonly string[]).includes(key)) {
      throw new Error(`unknown REDLINE_* environment variable: ${key}`);
    }
  }
}

function parseJsonObject(raw: string, maximumBytes: number, label: string): JsonObject {
  if (Buffer.byteLength(raw, 'utf8') > maximumBytes) throw new Error(`${label} exceeds its byte limit`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function assertExactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains an unsupported field`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing a required field`);
  }
}

function boundedString(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length === 0 || value.length > maximumLength) throw new Error(`${label} is invalid`);
  if (value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function parseModelConfig(raw: string): ModelConfiguration {
  const parsed = parseJsonObject(raw, MAX_MODEL_CONFIG_BYTES, 'model-config');
  assertExactKeys(parsed, ['provider', 'endpoint', 'model'], 'model-config');

  const provider = boundedString(parsed.provider, 64, 'model-config provider');
  if (!PROVIDER_PATTERN.test(provider)) throw new Error('model-config provider is invalid');
  const endpointValue = boundedString(parsed.endpoint, 2_048, 'model-config endpoint');
  const model = boundedString(parsed.model, 256, 'model-config model');

  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error('model-config endpoint must be an absolute URL');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('model-config endpoint must use http or https');
  }
  return Object.freeze({ provider, endpoint: endpointValue, model });
}

export function selectModelCredential(
  model: ModelConfiguration,
  modelCredentials: string,
  mapLabel = 'model-auth',
): SelectedModelCredential {
  const credentials = parseJsonObject(modelCredentials, MAX_MODEL_CREDENTIALS_BYTES, mapLabel);
  if (!Object.hasOwn(credentials, model.provider)) {
    throw new Error(`${mapLabel} has no entry for the configured provider`);
  }
  const value = credentials[model.provider];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error('selected model credential is invalid');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SELECTED_CREDENTIAL_BYTES) {
    throw new Error('selected model credential exceeds its byte limit');
  }
  return Object.freeze({ provider: model.provider, value });
}

function optionalFindingScope(raw: string | undefined): FindingScope {
  const selected = raw ?? 'defects';
  if (!(FINDING_SCOPES as readonly string[]).includes(selected)) {
    throw new Error('finding scope is unsupported');
  }
  return selected as FindingScope;
}

function optionalTimeout(raw: string | undefined): Duration {
  const selected = raw !== undefined && raw.length > 0 ? raw : DEFAULT_TIMEOUT_INPUT;
  return parseDuration(selected, { maximumMinutes: MAX_TIMEOUT_MINUTES });
}

function optionalVerbosity(raw: string | undefined): ReviewVerbosity {
  const selected = raw === undefined || raw.length === 0 ? DEFAULT_VERBOSITY : raw;
  if (!(VERBOSITIES as readonly string[]).includes(selected)) {
    throw new Error('REDLINE_VERBOSITY is unsupported; use silent, progress, or full-output');
  }
  return selected as ReviewVerbosity;
}

const REVIEW_REQUIRED_KEYS = [
  'REDLINE_HARNESS',
  'REDLINE_REVIEW_DIR',
  'REDLINE_SOURCE_DIR',
  'REDLINE_OUTPUT_DIR',
  'REDLINE_MODEL_CONFIG',
  'REDLINE_MODEL_AUTH',
] as const;

const PUBLICATION_REQUIRED_KEYS = [
  'REDLINE_PUBLISH_TOKEN',
  'REDLINE_REPOSITORY',
  'REDLINE_PULL_REQUEST',
  'REDLINE_HEAD',
] as const;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Parses the publication context. All four variables must arrive together;
 * a partial selection fails instead of degrading to artifact-only mode.
 */
function optionalPublication(environment: NodeJS.ProcessEnv): PublicationEnvironment | undefined {
  const values = PUBLICATION_REQUIRED_KEYS.map((key) => environment[key] ?? '');
  const provided = PUBLICATION_REQUIRED_KEYS.filter((_key, index) => (values[index] ?? '').length > 0);
  if (provided.length === 0) return undefined;
  if (provided.length < PUBLICATION_REQUIRED_KEYS.length) {
    const missing = PUBLICATION_REQUIRED_KEYS.filter((key) => !provided.includes(key));
    throw new Error(
      `publication requires ${PUBLICATION_REQUIRED_KEYS.join(', ')} together; missing: ${missing.join(', ')}`,
    );
  }
  const token = values[0] ?? '';
  if (token !== token.trim() || /\p{Cc}/u.test(token)) throw new Error('publication token is invalid');
  const repository = values[1] ?? '';
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('REDLINE_REPOSITORY must use owner/name syntax');
  const pullRequestRaw = values[2] ?? '';
  if (!/^[1-9][0-9]*$/u.test(pullRequestRaw)) throw new Error('REDLINE_PULL_REQUEST must be a pull request number');
  const head = values[3] ?? '';
  if (!COMMIT_PATTERN.test(head)) throw new Error('REDLINE_HEAD must be a full commit identifier');
  return Object.freeze({
    token,
    repository,
    pullRequest: Number.parseInt(pullRequestRaw, 10),
    head,
  });
}

export function parseReviewEnvironment(environment: NodeJS.ProcessEnv): ParsedReviewEnvironment {
  assertKnownEnvironment(environment);

  // Optional values are validated in both modes so typos fail loudly.
  const findingScope = optionalFindingScope(environment.REDLINE_FINDING_SCOPE);
  const verbosity = optionalVerbosity(environment.REDLINE_VERBOSITY);
  const timeout = optionalTimeout(environment.REDLINE_TIMEOUT);
  const publication = optionalPublication(environment);

  const values = REVIEW_REQUIRED_KEYS.map((key) => environment[key] ?? '');
  const provided = REVIEW_REQUIRED_KEYS.filter((_key, index) => (values[index] ?? '').length > 0);
  if (provided.length === 0) {
    if (publication !== undefined) throw new Error('publication requires review execution');
    return Object.freeze({ mode: 'context-only', timeout, verbosity, review: undefined, publication: undefined });
  }
  if (provided.length < REVIEW_REQUIRED_KEYS.length) {
    const missing = REVIEW_REQUIRED_KEYS.filter((key) => !provided.includes(key));
    throw new Error(`review execution requires ${REVIEW_REQUIRED_KEYS.join(', ')} together; missing: ${missing.join(', ')}`);
  }

  const harnessRaw = environment.REDLINE_HARNESS ?? '';
  if (!isHarnessName(harnessRaw)) {
    throw new Error('REDLINE_HARNESS is unsupported');
  }
  const model = parseModelConfig(environment.REDLINE_MODEL_CONFIG ?? '');
  const credential = selectModelCredential(model, environment.REDLINE_MODEL_AUTH ?? '');

  const review: ReviewEnvironment = Object.freeze({
    harness: harnessRaw,
    reviewDirectory: environment.REDLINE_REVIEW_DIR ?? '',
    sourceDirectory: environment.REDLINE_SOURCE_DIR ?? '',
    outputDirectory: environment.REDLINE_OUTPUT_DIR ?? '',
    model,
    credential,
    findingScope,
    timeout,
  });
  return Object.freeze({ mode: 'review', timeout, verbosity, review, publication });
}
