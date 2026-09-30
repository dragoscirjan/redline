import type { ReviewBackend } from './backend-process.js';
import type { ReportStyle } from './review-prompt.js';

const MAX_MODEL_CONFIG_BYTES = 16 * 1024;
const MAX_MODEL_CREDENTIALS_BYTES = 64 * 1024;
const MAX_SELECTED_CREDENTIAL_BYTES = 16 * 1024;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export interface OpenAiCompatibleModelConfiguration {
  readonly provider: string;
  readonly endpoint: string;
  readonly model: string;
}

export interface FirstRunnableReviewConfiguration {
  readonly backend: ReviewBackend;
  readonly model: OpenAiCompatibleModelConfiguration;
  readonly credentialIsolation: 'direct';
  readonly findingScope: 'defects';
  readonly reportStyle: ReportStyle;
}

export interface FirstRunnableReviewConfigurationInput {
  backend: unknown;
  modelConfig: string;
  credentialIsolation: unknown;
  findingScope?: unknown;
  reportStyle?: unknown;
}

export interface SelectedModelCredential {
  readonly provider: string;
  readonly value: string;
}

type JsonObject = Record<string, unknown>;

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
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new Error(`${label} is invalid`);
  }
  if (value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function parseModelConfig(raw: string): OpenAiCompatibleModelConfiguration {
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
    throw new Error('model-config endpoint must use HTTP or HTTPS');
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('model-config endpoint must not contain credentials or a fragment');
  }

  return Object.freeze({
    provider,
    endpoint: endpoint.toString(),
    model,
  });
}

export function parseFirstRunnableReviewConfiguration(
  input: FirstRunnableReviewConfigurationInput,
): FirstRunnableReviewConfiguration {
  if (input.backend !== 'pi' && input.backend !== 'opencode') {
    throw new Error('review backend is unsupported');
  }
  if (input.credentialIsolation !== 'direct') {
    throw new Error('credential-isolation must be explicitly set to direct');
  }
  if ((input.findingScope ?? 'defects') !== 'defects') {
    throw new Error('the first runnable configuration supports only the defects finding scope');
  }
  const reportStyle = input.reportStyle ?? 'single-block';
  if (reportStyle !== 'single-block' && reportStyle !== 'inline') {
    throw new Error('report style is unsupported');
  }

  return Object.freeze({
    backend: input.backend,
    model: parseModelConfig(input.modelConfig),
    credentialIsolation: 'direct',
    findingScope: 'defects',
    reportStyle,
  });
}

export function selectDirectModelCredential(
  configuration: FirstRunnableReviewConfiguration,
  modelCredentials: string,
): SelectedModelCredential {
  const credentials = parseJsonObject(
    modelCredentials,
    MAX_MODEL_CREDENTIALS_BYTES,
    'model-credentials',
  );
  if (!Object.hasOwn(credentials, configuration.model.provider)) {
    throw new Error('model-credentials has no entry for the configured provider');
  }
  const value = credentials[configuration.model.provider];
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
  return Object.freeze({ provider: configuration.model.provider, value });
}
