/**
 * Environment-variable contract between the GitHub Action and the review
 * tool (interim contract; a structured invocation API replaces it later).
 *
 * Parsing is authoritative and strict: unknown `REDLINE_*` variables are
 * rejected (typos fail loudly), review inputs must arrive together, and
 * every value is bounded and schema-checked. Optional values are validated
 * even in context-only mode so misconfiguration never passes silently.
 */

import { MAX_TIMEOUT_MINUTES, parseDuration, type Duration } from '../duration.ts';
import { parseOutputTokens } from '../harness-executor/output-budget.ts';
import { isHarnessName } from '../harness-executor/registry.ts';
import type { HarnessName } from '../harness-executor/types.ts';
import type { ReviewCodeContextInput } from './indexed-context.ts';
import { FINDING_SCOPES, type FindingScope } from './types.ts';

export const REDLINE_ENV_KEYS = [
  'REDLINE_HARNESS',
  'REDLINE_REVIEW_DIR',
  'REDLINE_SOURCE_DIR',
  'REDLINE_OUTPUT_DIR',
  'REDLINE_CODE_CONTEXT',
  'REDLINE_CODE_CONTEXT_REPOSITORY',
  'REDLINE_MODEL_CONFIG',
  'REDLINE_MODEL_AUTH',
  'REDLINE_FINDING_SCOPE',
  'REDLINE_TIMEOUT',
  'REDLINE_RUN_TIMEOUT',
  'REDLINE_REVIEW_CONCURRENCY',
  'REDLINE_MAX_OUTPUT_TOKENS',
  'REDLINE_REUSE_DIR',
  'REDLINE_REUSE_NAMESPACE',
  'REDLINE_PUBLISH_TOKEN',
  'REDLINE_REPOSITORY',
  'REDLINE_PULL_REQUEST',
  'REDLINE_HEAD',
  'REDLINE_VERBOSITY',
  'REDLINE_FAILURE_REASON',
] as const;

/** How much of the live model stream lands in the run log. */
export const VERBOSITIES = ['silent', 'progress', 'full-output'] as const;
export type ReviewVerbosity = (typeof VERBOSITIES)[number];
/** `progress` (dots) is the default: alive without flooding the log. */
export const DEFAULT_VERBOSITY: ReviewVerbosity = 'progress';

export const DEFAULT_TIMEOUT_INPUT = '4m';
export const DEFAULT_RUN_TIMEOUT_INPUT = '10m';
export const DEFAULT_REVIEW_CONCURRENCY = 4;
export const MIN_REVIEW_CONCURRENCY = 1;
export const MAX_REVIEW_CONCURRENCY = 8;

const MAX_MODEL_CONFIG_BYTES = 16 * 1024;
const MAX_MODEL_CREDENTIALS_BYTES = 64 * 1024;
const MAX_SELECTED_CREDENTIAL_BYTES = 16 * 1024;
const MAX_CODE_CONTEXT_PATH_BYTES = 4_096;
const MAX_REUSE_PATH_BYTES = 4_096;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export type ReviewMode = 'context-only' | 'review';

/**
 * Environment for the announce modes (`--announce-only`,
 * `--announce-failure`): publication context plus the harness and model
 * id the running body displays. No review execution happens here.
 */
export interface AnnounceEnvironment {
  readonly publication: PublicationEnvironment;
  readonly harness: HarnessName;
  readonly model: string;
}

/**
 * Environment for `--publish-only`: publication context plus the output
 * directory the review run wrote its records and summary to.
 */
export interface PublishOnlyEnvironment {
  readonly publication: PublicationEnvironment;
  readonly outputDirectory: string;
}

export interface ModelConfiguration {
  readonly provider: string;
  readonly endpoint: string;
  readonly model: string;
  /**
   * `"none"` selects a credential-less profile for endpoints that need no
   * authentication — local model runners (Ollama, LM Studio, llama.cpp
   * server, vLLM) and unauthenticated CI mocks. `REDLINE_MODEL_AUTH` is
   * not required, and must not be supplied, in this mode.
   */
  readonly auth: 'none' | undefined;
}

export interface SelectedModelCredential {
  readonly provider: string;
  readonly value: string;
}

export interface ReviewReuseEnvironment {
  readonly directory: string;
  readonly namespace: string;
}

export interface ReviewEnvironment {
  /** Trusted adapter identity, not an environment variable or repository input. */
  readonly executionIdentity?: string;
  readonly harness: HarnessName;
  readonly reviewDirectory: string;
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
  readonly codeContext: ReviewCodeContextInput | undefined;
  readonly model: ModelConfiguration;
  /** Undefined in the credential-less profile (`auth: "none"`). */
  readonly credential: SelectedModelCredential | undefined;
  readonly findingScope: FindingScope;
  /** Maximum time for one file's complete harness invocation. */
  readonly timeout: Duration;
  /** Maximum wall time for the complete review run before remaining files are omitted. */
  readonly runTimeout: Duration;
  /** Trusted maximum number of simultaneous per-file harness calls. */
  readonly reviewConcurrency: number;
  readonly maxOutputTokens?: number | undefined;
  readonly modelProtocol?: 'compatible' | 'openrouter-json' | undefined;
  readonly scheduling?: 'largest-first' | 'mixed' | undefined;
  /** Local CLI opt-in. Unset preserves legacy Action retry behavior; zero disables retries. */
  readonly retries?: number | undefined;
  readonly headContext?: boolean | undefined;
  /** Optional action-owned cross-run record cache; restored contents remain untrusted. */
  readonly reuse?: ReviewReuseEnvironment | undefined;
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
  readonly runTimeout: Duration;
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
  const hasAuthField = Object.hasOwn(parsed, 'auth');
  assertExactKeys(
    parsed,
    hasAuthField ? ['provider', 'endpoint', 'model', 'auth'] : ['provider', 'endpoint', 'model'],
    'model-config',
  );

  const provider = boundedString(parsed.provider, 64, 'model-config provider');
  if (!PROVIDER_PATTERN.test(provider)) throw new Error('model-config provider is invalid');
  const endpointValue = boundedString(parsed.endpoint, 2_048, 'model-config endpoint');
  const model = boundedString(parsed.model, 256, 'model-config model');
  const auth = hasAuthField ? boundedString(parsed.auth, 16, 'model-config auth') : undefined;
  if (auth !== undefined && auth !== 'none') throw new Error('model-config auth only supports "none"');

  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error('model-config endpoint must be an absolute URL');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('model-config endpoint must use http or https');
  }
  return Object.freeze({ provider, endpoint: endpointValue, model, auth });
}

export function selectModelCredential(
  model: ModelConfiguration,
  modelCredentials: string,
  mapLabel = 'model-auth',
): SelectedModelCredential | undefined {
  // Credential-less profile: local model runners and unauthenticated mocks
  // ignore the authorization header, so no credential is selected.
  if (model.auth === 'none') return undefined;
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

function optionalTimeout(raw: string | undefined, fallback: string): Duration {
  const selected = raw !== undefined && raw.length > 0 ? raw : fallback;
  return parseDuration(selected, { maximumMinutes: MAX_TIMEOUT_MINUTES });
}

function optionalVerbosity(raw: string | undefined): ReviewVerbosity {
  const selected = raw === undefined || raw.length === 0 ? DEFAULT_VERBOSITY : raw;
  if (!(VERBOSITIES as readonly string[]).includes(selected)) {
    throw new Error('REDLINE_VERBOSITY is unsupported; use silent, progress, or full-output');
  }
  return selected as ReviewVerbosity;
}

function optionalReviewConcurrency(raw: string | undefined): number {
  const selected = raw === undefined || raw.length === 0 ? `${DEFAULT_REVIEW_CONCURRENCY}` : raw;
  if (!/^[1-8]$/u.test(selected)) {
    throw new Error('REDLINE_REVIEW_CONCURRENCY must be an integer from 1 through 8');
  }
  return Number.parseInt(selected, 10);
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

function optionalReviewReuse(environment: NodeJS.ProcessEnv): ReviewReuseEnvironment | undefined {
  const directory = environment.REDLINE_REUSE_DIR ?? '';
  const namespace = environment.REDLINE_REUSE_NAMESPACE ?? '';
  if (directory.length === 0 && namespace.length === 0) return undefined;
  if (directory.length === 0 || namespace.length === 0) {
    throw new Error('REDLINE_REUSE_DIR and REDLINE_REUSE_NAMESPACE must arrive together');
  }
  if (Buffer.byteLength(directory, 'utf8') > MAX_REUSE_PATH_BYTES || CONTROL_CHARACTER_PATTERN.test(directory)) {
    throw new Error('REDLINE_REUSE_DIR is invalid');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/u.test(namespace)) {
    throw new Error('REDLINE_REUSE_NAMESPACE must use owner/name#pull-request syntax');
  }
  return Object.freeze({ directory, namespace });
}

function optionalCodeContext(environment: NodeJS.ProcessEnv): ReviewCodeContextInput | undefined {
  const path = environment.REDLINE_CODE_CONTEXT ?? '';
  const repository = environment.REDLINE_CODE_CONTEXT_REPOSITORY ?? '';
  if (path.length === 0 && repository.length === 0) return undefined;
  if (path.length === 0 || repository.length === 0) {
    throw new Error('REDLINE_CODE_CONTEXT and REDLINE_CODE_CONTEXT_REPOSITORY must arrive together');
  }
  if (Buffer.byteLength(path, 'utf8') > MAX_CODE_CONTEXT_PATH_BYTES || CONTROL_CHARACTER_PATTERN.test(path)) {
    throw new Error('REDLINE_CODE_CONTEXT is invalid');
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('REDLINE_CODE_CONTEXT_REPOSITORY must use owner/name syntax');
  }
  return Object.freeze({ path, repository });
}

function publicationFromValues(values: readonly string[]): PublicationEnvironment {
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
  return publicationFromValues(values);
}

/**
 * Required publication context for the single-purpose CLI modes
 * (`--announce-only`, `--announce-failure`, `--publish-only`): all four
 * variables must be present. REDLINE_FAILURE_REASON is optional and only
 * meaningful to the failure mode; it is bounded, redacted, and sanitized
 * before it reaches a comment.
 */
function requiredPublication(environment: NodeJS.ProcessEnv): PublicationEnvironment {
  const values = PUBLICATION_REQUIRED_KEYS.map((key) => environment[key] ?? '');
  const missing = PUBLICATION_REQUIRED_KEYS.filter((_key, index) => (values[index] ?? '').length === 0);
  if (missing.length > 0) {
    throw new Error(`publication requires ${PUBLICATION_REQUIRED_KEYS.join(', ')} together; missing: ${missing.join(', ')}`);
  }
  return publicationFromValues(values);
}

export function parseFailureReason(raw: string | undefined): string {
  const bounded = (raw ?? '')
    .slice(0, 500)
    .replaceAll(/[\u0000-\u001f]+/gu, ' ')
    .trim();
  return bounded;
}

/**
 * Announce modes: publication context and the display fields must arrive
 * together; review execution variables are not part of this contract.
 */
export function parseAnnounceEnvironment(environment: NodeJS.ProcessEnv): AnnounceEnvironment {
  assertKnownEnvironment(environment);
  const publication = requiredPublication(environment);
  const harnessRaw = environment.REDLINE_HARNESS ?? '';
  if (!isHarnessName(harnessRaw)) throw new Error('REDLINE_HARNESS is unsupported');
  const model = parseModelConfig(environment.REDLINE_MODEL_CONFIG ?? '');
  return Object.freeze({ publication, harness: harnessRaw, model: model.model });
}

export function parsePublishOnlyEnvironment(environment: NodeJS.ProcessEnv): PublishOnlyEnvironment {
  assertKnownEnvironment(environment);
  const publication = requiredPublication(environment);
  const outputDirectory = environment.REDLINE_OUTPUT_DIR ?? '';
  if (outputDirectory.length === 0) throw new Error('publish-only requires REDLINE_OUTPUT_DIR');
  return Object.freeze({ publication, outputDirectory });
}

export function parseReviewEnvironment(environment: NodeJS.ProcessEnv): ParsedReviewEnvironment {
  assertKnownEnvironment(environment);

  // Optional values are validated in both modes so typos fail loudly.
  const findingScope = optionalFindingScope(environment.REDLINE_FINDING_SCOPE);
  const verbosity = optionalVerbosity(environment.REDLINE_VERBOSITY);
  const timeout = optionalTimeout(environment.REDLINE_TIMEOUT, DEFAULT_TIMEOUT_INPUT);
  const runTimeout = optionalTimeout(environment.REDLINE_RUN_TIMEOUT, DEFAULT_RUN_TIMEOUT_INPUT);
  const reviewConcurrency = optionalReviewConcurrency(environment.REDLINE_REVIEW_CONCURRENCY);
  const maxOutputTokens = parseOutputTokens(environment.REDLINE_MAX_OUTPUT_TOKENS);
  const publication = optionalPublication(environment);
  const codeContext = optionalCodeContext(environment);
  const reuse = optionalReviewReuse(environment);

  const values = REVIEW_REQUIRED_KEYS.map((key) => environment[key] ?? '');
  const provided = REVIEW_REQUIRED_KEYS.filter((_key, index) => (values[index] ?? '').length > 0);
  if (provided.length === 0) {
    if (publication !== undefined) throw new Error('publication requires review execution');
    if (codeContext !== undefined) throw new Error('indexed code context requires review execution');
    if (reuse !== undefined) throw new Error('review reuse requires review execution');
    return Object.freeze({
      mode: 'context-only', timeout, runTimeout, verbosity, review: undefined, publication: undefined,
    });
  }
  const missing = REVIEW_REQUIRED_KEYS.filter((key) => !provided.includes(key));
  const credentialLessAllowed =
    missing.length === 1 && missing[0] === 'REDLINE_MODEL_AUTH' &&
    parseModelConfig(environment.REDLINE_MODEL_CONFIG ?? '').auth === 'none';
  if (missing.length > 0 && !credentialLessAllowed) {
    throw new Error(`review execution requires ${REVIEW_REQUIRED_KEYS.join(', ')} together; missing: ${missing.join(', ')}`);
  }

  const harnessRaw = environment.REDLINE_HARNESS ?? '';
  if (!isHarnessName(harnessRaw)) {
    throw new Error('REDLINE_HARNESS is unsupported');
  }
  const model = parseModelConfig(environment.REDLINE_MODEL_CONFIG ?? '');
  const modelAuthRaw = environment.REDLINE_MODEL_AUTH ?? '';
  let credential: SelectedModelCredential | undefined;
  if (model.auth === 'none') {
    // A supplied credential map is tolerated and NOT consulted: the
    // action's review gate requires a non-empty model-auth, so action
    // users pass a placeholder for local-model servers. The credential
    // never reaches the harness either way.
    credential = undefined;
  } else {
    credential = selectModelCredential(model, modelAuthRaw);
  }

  const review: ReviewEnvironment = Object.freeze({
    harness: harnessRaw,
    reviewDirectory: environment.REDLINE_REVIEW_DIR ?? '',
    sourceDirectory: environment.REDLINE_SOURCE_DIR ?? '',
    outputDirectory: environment.REDLINE_OUTPUT_DIR ?? '',
    codeContext,
    model,
    credential,
    findingScope,
    timeout,
    runTimeout,
    reviewConcurrency,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    reuse,
  });
  return Object.freeze({ mode: 'review', timeout, runTimeout, verbosity, review, publication });
}
