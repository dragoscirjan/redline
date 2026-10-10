import { createHash } from 'node:crypto';
import {
  ARTIFACT_CACHE_CONTRACT_VERSION,
  ARTIFACT_MANIFEST_VERSION,
  INSTALLED_TOOL_MANIFEST_VERSION,
  REVIEW_TOOL_DESCRIPTOR_VERSION,
  type ArtifactFileEntry,
  type ArtifactIdentity,
  type ArtifactManifest,
  type ArtifactRetentionPolicy,
  type CodeIndexArtifactIdentity,
  type ContentDigest,
  type DerivedArtifactIdentity,
  type DerivedArtifactKind,
  type InstalledToolManifest,
  type NamedArtifactInput,
  type ReviewToolDescriptor,
  type ReviewToolFamily,
  type ReviewToolLicense,
  type Sha256Digest,
  type ToolArtifactIdentity,
  type ToolArtifactKind,
  type ToolHealthProbe,
  type ToolPlatform,
  type ToolRuntimeRequirement,
} from './types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DIGEST_PATTERN = /^(?:sha256:[0-9a-f]{64}|sha512:[0-9a-f]{128})$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4_096;
const MAX_FILES = 100_000;
const MAX_ARRAY = 1_000;

const TOOL_FAMILIES = new Set<ReviewToolFamily>(['harness', 'code-indexer']);
const TOOL_ARTIFACT_KINDS = new Set<ToolArtifactKind>(['tool-download', 'installed-tool']);
const DERIVED_ARTIFACT_KINDS = new Set<DerivedArtifactKind>([
  'normalized-query',
  'graph-delta',
  'change-impact-map',
  'context-plan',
]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function stringValue(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return value;
}

function optionalString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES): string | undefined {
  return value === undefined ? undefined : stringValue(value, label, maxBytes);
}

function identifier(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 128);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} has an invalid identifier`);
  return parsed;
}

function contentDigest(value: unknown, label: string): ContentDigest {
  const parsed = stringValue(value, label, 136);
  if (!DIGEST_PATTERN.test(parsed)) throw new Error(`${label} must be a labelled SHA-256 or SHA-512 digest`);
  return parsed as ContentDigest;
}

function sha256Digest(value: unknown, label: string): Sha256Digest {
  const parsed = stringValue(value, label, 71);
  if (!SHA256_PATTERN.test(parsed)) throw new Error(`${label} must be a labelled SHA-256 digest`);
  return parsed as Sha256Digest;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = integer(value, label);
  if (parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function arrayValue(value: unknown, label: string, maxLength = MAX_ARRAY): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new Error(`${label} is unsupported: ${String(value)}`);
  return value as T;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous !== undefined && current !== undefined && compareText(previous, current) >= 0) {
      throw new Error(`${label} must be sorted by raw string value without duplicates`);
    }
  }
}

function parseSortedStrings(value: unknown, label: string, maxLength = MAX_ARRAY): string[] {
  const parsed = arrayValue(value, label, maxLength)
    .map((item, index) => stringValue(item, `${label}[${index}]`, 256));
  sortedUnique(parsed, label);
  return parsed;
}

function repositoryPath(value: unknown, label: string): string {
  const parsed = stringValue(value, label, MAX_PATH_BYTES);
  const segments = parsed.split('/');
  if (
    parsed.startsWith('/') ||
    parsed.includes('\\') ||
    parsed.includes('\0') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) throw new Error(`${label} must be a normalized relative path`);
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function parsePlatform(value: unknown, label: string): ToolPlatform {
  const input = record(value, label);
  onlyKeys(input, ['operatingSystem', 'architecture'], label);
  return {
    operatingSystem: identifier(input['operatingSystem'], `${label}.operatingSystem`),
    architecture: identifier(input['architecture'], `${label}.architecture`),
  };
}

function parseLicense(value: unknown, label: string): ReviewToolLicense {
  const input = record(value, label);
  onlyKeys(input, ['name', 'spdx', 'url', 'redistribution', 'notice'], label);
  const spdx = input['spdx'] === null ? null : stringValue(input['spdx'], `${label}.spdx`, 128);
  const notice = optionalString(input['notice'], `${label}.notice`);
  return {
    name: stringValue(input['name'], `${label}.name`, 256),
    spdx,
    url: stringValue(input['url'], `${label}.url`, 2_048),
    redistribution: enumValue(
      input['redistribution'],
      new Set<ReviewToolLicense['redistribution']>(['allowed', 'conditional', 'prohibited', 'unknown']),
      `${label}.redistribution`,
    ),
    ...(notice === undefined ? {} : { notice }),
  };
}

function parseRuntime(value: unknown, label: string): ToolRuntimeRequirement {
  const input = record(value, label);
  onlyKeys(input, ['name', 'version', 'abi'], label);
  const abi = optionalString(input['abi'], `${label}.abi`, 256);
  return {
    name: identifier(input['name'], `${label}.name`),
    version: stringValue(input['version'], `${label}.version`, 256),
    ...(abi === undefined ? {} : { abi }),
  };
}

function parseHealthProbe(value: unknown, label: string): ToolHealthProbe {
  const input = record(value, label);
  onlyKeys(input, ['executable', 'args', 'expectedExitCode', 'expectedOutput'], label);
  const args = arrayValue(input['args'], `${label}.args`, 64)
    .map((item, index) => stringValue(item, `${label}.args[${index}]`, 4_096));
  const expectedExitCode = nonNegativeInteger(input['expectedExitCode'], `${label}.expectedExitCode`);
  if (expectedExitCode > 255) throw new Error(`${label}.expectedExitCode must not exceed 255`);
  const expectedOutput = optionalString(input['expectedOutput'], `${label}.expectedOutput`, 4_096);
  return {
    executable: repositoryPath(input['executable'], `${label}.executable`),
    args,
    expectedExitCode,
    ...(expectedOutput === undefined ? {} : { expectedOutput }),
  };
}

/** Parses trusted, versioned acquisition metadata for one exact review tool build. */
export function parseReviewToolDescriptor(value: unknown): ReviewToolDescriptor {
  const input = record(value, 'review tool descriptor');
  onlyKeys(input, [
    'version', 'id', 'displayName', 'family', 'providerId', 'toolVersion', 'distribution',
    'license', 'installerRecipeVersion', 'platform', 'runtimes', 'grammars', 'features', 'healthProbe',
  ], 'review tool descriptor');
  if (input['version'] !== REVIEW_TOOL_DESCRIPTOR_VERSION) {
    throw new Error(`review tool descriptor.version must be ${REVIEW_TOOL_DESCRIPTOR_VERSION}`);
  }
  const family = enumValue(input['family'], TOOL_FAMILIES, 'review tool descriptor.family');
  const providerId = input['providerId'] === undefined
    ? undefined
    : identifier(input['providerId'], 'review tool descriptor.providerId');
  if (family === 'code-indexer' && providerId === undefined) {
    throw new Error('code-indexer tool descriptors require providerId');
  }
  if (family === 'harness' && providerId !== undefined) {
    throw new Error('harness tool descriptors must not declare providerId');
  }
  const distributionInput = record(input['distribution'], 'review tool descriptor.distribution');
  onlyKeys(distributionInput, ['source', 'digest'], 'review tool descriptor.distribution');
  const distributionDigest = distributionInput['digest'] === undefined
    ? undefined
    : contentDigest(distributionInput['digest'], 'review tool descriptor.distribution.digest');
  const runtimes = arrayValue(input['runtimes'], 'review tool descriptor.runtimes', 32)
    .map((item, index) => parseRuntime(item, `review tool descriptor.runtimes[${index}]`));
  sortedUnique(runtimes.map((runtime) => runtime.name), 'review tool descriptor.runtimes');
  return {
    version: REVIEW_TOOL_DESCRIPTOR_VERSION,
    id: identifier(input['id'], 'review tool descriptor.id'),
    displayName: stringValue(input['displayName'], 'review tool descriptor.displayName', 256),
    family,
    ...(providerId === undefined ? {} : { providerId }),
    toolVersion: stringValue(input['toolVersion'], 'review tool descriptor.toolVersion', 256),
    distribution: {
      source: stringValue(distributionInput['source'], 'review tool descriptor.distribution.source', 2_048),
      ...(distributionDigest === undefined ? {} : { digest: distributionDigest }),
    },
    license: parseLicense(input['license'], 'review tool descriptor.license'),
    installerRecipeVersion: stringValue(
      input['installerRecipeVersion'],
      'review tool descriptor.installerRecipeVersion',
      256,
    ),
    platform: parsePlatform(input['platform'], 'review tool descriptor.platform'),
    runtimes,
    grammars: parseSortedStrings(input['grammars'], 'review tool descriptor.grammars'),
    features: parseSortedStrings(input['features'], 'review tool descriptor.features'),
    healthProbe: parseHealthProbe(input['healthProbe'], 'review tool descriptor.healthProbe'),
  };
}

/** Digest used by installed-tool and download cache identities. */
export function reviewToolDescriptorDigest(descriptor: ReviewToolDescriptor): Sha256Digest {
  return sha256(parseReviewToolDescriptor(descriptor));
}

function parseNamedInput(value: unknown, label: string): NamedArtifactInput {
  const input = record(value, label);
  onlyKeys(input, ['name', 'digest'], label);
  return {
    name: identifier(input['name'], `${label}.name`),
    digest: sha256Digest(input['digest'], `${label}.digest`),
  };
}

/** Parses a complete artifact identity. No mutable branch names are accepted. */
export function parseArtifactIdentity(value: unknown): ArtifactIdentity {
  const input = record(value, 'artifact identity');
  if (input['version'] !== ARTIFACT_CACHE_CONTRACT_VERSION) {
    throw new Error(`artifact identity.version must be ${ARTIFACT_CACHE_CONTRACT_VERSION}`);
  }
  const kind = stringValue(input['kind'], 'artifact identity.kind', 64);
  if (TOOL_ARTIFACT_KINDS.has(kind as ToolArtifactKind)) {
    onlyKeys(input, ['version', 'kind', 'descriptorDigest'], 'artifact identity');
    return {
      version: ARTIFACT_CACHE_CONTRACT_VERSION,
      kind: kind as ToolArtifactKind,
      descriptorDigest: sha256Digest(input['descriptorDigest'], 'artifact identity.descriptorDigest'),
    } satisfies ToolArtifactIdentity;
  }
  if (kind === 'code-index-snapshot') {
    onlyKeys(input, [
      'version', 'kind', 'providerCompatibilityDigest', 'snapshotCompatibilityDigest', 'storageFormat', 'platform',
    ], 'artifact identity');
    const platform = input['platform'] === undefined
      ? undefined
      : parsePlatform(input['platform'], 'artifact identity.platform');
    return {
      version: ARTIFACT_CACHE_CONTRACT_VERSION,
      kind,
      providerCompatibilityDigest: sha256Digest(
        input['providerCompatibilityDigest'],
        'artifact identity.providerCompatibilityDigest',
      ),
      snapshotCompatibilityDigest: sha256Digest(
        input['snapshotCompatibilityDigest'],
        'artifact identity.snapshotCompatibilityDigest',
      ),
      storageFormat: stringValue(input['storageFormat'], 'artifact identity.storageFormat', 256),
      ...(platform === undefined ? {} : { platform }),
    } satisfies CodeIndexArtifactIdentity;
  }
  if (DERIVED_ARTIFACT_KINDS.has(kind as DerivedArtifactKind)) {
    onlyKeys(input, ['version', 'kind', 'contractVersion', 'inputs'], 'artifact identity');
    const inputs = arrayValue(input['inputs'], 'artifact identity.inputs', MAX_ARRAY)
      .map((item, index) => parseNamedInput(item, `artifact identity.inputs[${index}]`));
    if (inputs.length === 0) throw new Error('derived artifact identities require at least one input digest');
    sortedUnique(inputs.map((item) => item.name), 'artifact identity.inputs');
    return {
      version: ARTIFACT_CACHE_CONTRACT_VERSION,
      kind: kind as DerivedArtifactKind,
      contractVersion: stringValue(input['contractVersion'], 'artifact identity.contractVersion', 256),
      inputs,
    } satisfies DerivedArtifactIdentity;
  }
  throw new Error(`artifact identity.kind is unsupported: ${kind}`);
}

export function artifactIdentityDigest(identity: ArtifactIdentity): Sha256Digest {
  return sha256(parseArtifactIdentity(identity));
}

export function artifactCacheKey(identity: ArtifactIdentity): string {
  const normalized = parseArtifactIdentity(identity);
  const digest = artifactIdentityDigest(normalized).slice('sha256:'.length);
  return `v${ARTIFACT_CACHE_CONTRACT_VERSION}/${normalized.kind}/${digest}`;
}

function parseFileEntry(value: unknown, label: string): ArtifactFileEntry {
  const input = record(value, label);
  onlyKeys(input, ['path', 'digest', 'bytes', 'mode'], label);
  const mode = nonNegativeInteger(input['mode'], `${label}.mode`);
  if (mode > 0o777) throw new Error(`${label}.mode must contain only portable permission bits`);
  return {
    path: repositoryPath(input['path'], `${label}.path`),
    digest: sha256Digest(input['digest'], `${label}.digest`),
    bytes: nonNegativeInteger(input['bytes'], `${label}.bytes`),
    mode,
  };
}

export function parseArtifactFileEntries(value: unknown, label = 'artifact files'): ArtifactFileEntry[] {
  const files = arrayValue(value, label, MAX_FILES)
    .map((item, index) => parseFileEntry(item, `${label}[${index}]`));
  sortedUnique(files.map((file) => file.path), label);
  return files;
}

export function artifactPayloadDigest(files: readonly ArtifactFileEntry[]): Sha256Digest {
  return sha256(parseArtifactFileEntries(files));
}

/** Parses metadata published beside one immutable cached directory payload. */
export function parseArtifactManifest(value: unknown): ArtifactManifest {
  const input = record(value, 'artifact manifest');
  onlyKeys(input, [
    'version', 'key', 'identityDigest', 'identity', 'payloadDigest', 'files', 'createdAtMs', 'expiresAtMs',
  ], 'artifact manifest');
  if (input['version'] !== ARTIFACT_MANIFEST_VERSION) {
    throw new Error(`artifact manifest.version must be ${ARTIFACT_MANIFEST_VERSION}`);
  }
  const identity = parseArtifactIdentity(input['identity']);
  const identityDigest = sha256Digest(input['identityDigest'], 'artifact manifest.identityDigest');
  const expectedIdentityDigest = artifactIdentityDigest(identity);
  if (identityDigest !== expectedIdentityDigest) throw new Error('artifact manifest identityDigest does not match identity');
  const key = stringValue(input['key'], 'artifact manifest.key', 256);
  if (key !== artifactCacheKey(identity)) throw new Error('artifact manifest key does not match identity');
  const files = parseArtifactFileEntries(input['files'], 'artifact manifest.files');
  const payloadDigest = sha256Digest(input['payloadDigest'], 'artifact manifest.payloadDigest');
  if (payloadDigest !== artifactPayloadDigest(files)) throw new Error('artifact manifest payloadDigest does not match files');
  const createdAtMs = nonNegativeInteger(input['createdAtMs'], 'artifact manifest.createdAtMs');
  const expiresAtMs = input['expiresAtMs'] === undefined
    ? undefined
    : nonNegativeInteger(input['expiresAtMs'], 'artifact manifest.expiresAtMs');
  if (expiresAtMs !== undefined && expiresAtMs <= createdAtMs) {
    throw new Error('artifact manifest.expiresAtMs must follow createdAtMs');
  }
  return {
    version: ARTIFACT_MANIFEST_VERSION,
    key,
    identityDigest,
    identity,
    payloadDigest,
    files,
    createdAtMs,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
}

export function parseInstalledToolManifest(value: unknown): InstalledToolManifest {
  const input = record(value, 'installed tool manifest');
  onlyKeys(input, ['version', 'descriptorDigest', 'payloadDigest', 'files', 'executablePaths'], 'installed tool manifest');
  if (input['version'] !== INSTALLED_TOOL_MANIFEST_VERSION) {
    throw new Error(`installed tool manifest.version must be ${INSTALLED_TOOL_MANIFEST_VERSION}`);
  }
  const files = parseArtifactFileEntries(input['files'], 'installed tool manifest.files');
  const payloadDigest = sha256Digest(input['payloadDigest'], 'installed tool manifest.payloadDigest');
  if (payloadDigest !== artifactPayloadDigest(files)) {
    throw new Error('installed tool manifest.payloadDigest does not match files');
  }
  const executablePaths = parseSortedStrings(
    input['executablePaths'],
    'installed tool manifest.executablePaths',
    MAX_FILES,
  ).map((path, index) => repositoryPath(path, `installed tool manifest.executablePaths[${index}]`));
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  for (const path of executablePaths) {
    const file = filesByPath.get(path);
    if (file === undefined) throw new Error(`installed executable is absent from file manifest: ${path}`);
    if ((file.mode & 0o111) === 0) throw new Error(`installed executable lacks execute permission: ${path}`);
  }
  return {
    version: INSTALLED_TOOL_MANIFEST_VERSION,
    descriptorDigest: sha256Digest(input['descriptorDigest'], 'installed tool manifest.descriptorDigest'),
    payloadDigest,
    files,
    executablePaths,
  };
}

export function parseArtifactRetentionPolicy(value: unknown): ArtifactRetentionPolicy {
  const input = record(value, 'artifact retention policy');
  onlyKeys(input, ['maxAgeMs', 'maxBytes', 'maxEntries'], 'artifact retention policy');
  const maxAgeMs = input['maxAgeMs'] === undefined
    ? undefined
    : positiveInteger(input['maxAgeMs'], 'artifact retention policy.maxAgeMs');
  const maxBytes = input['maxBytes'] === undefined
    ? undefined
    : positiveInteger(input['maxBytes'], 'artifact retention policy.maxBytes');
  const maxEntries = input['maxEntries'] === undefined
    ? undefined
    : positiveInteger(input['maxEntries'], 'artifact retention policy.maxEntries');
  if (maxAgeMs === undefined && maxBytes === undefined && maxEntries === undefined) {
    throw new Error('artifact retention policy requires at least one bound');
  }
  return {
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(maxEntries === undefined ? {} : { maxEntries }),
  };
}
