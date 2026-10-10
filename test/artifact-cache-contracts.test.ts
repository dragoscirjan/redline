import { describe, expect, it } from 'vitest';
import {
  artifactCacheKey,
  artifactIdentityDigest,
  artifactPayloadDigest,
  parseArtifactIdentity,
  parseArtifactManifest,
  parseArtifactRetentionPolicy,
  parseInstalledToolManifest,
  parseReviewToolDescriptor,
  reviewToolDescriptorDigest,
} from '../src/artifact-cache/contracts.js';
import type {
  ArtifactFileEntry,
  CodeIndexArtifactIdentity,
  ReviewToolDescriptor,
} from '../src/artifact-cache/types.js';

const A = `sha256:${'a'.repeat(64)}` as const;
const B = `sha256:${'b'.repeat(64)}` as const;
const C = `sha256:${'c'.repeat(64)}` as const;

function descriptor(overrides: Partial<ReviewToolDescriptor> = {}): ReviewToolDescriptor {
  return {
    version: 1,
    id: 'gitnexus',
    displayName: 'GitNexus',
    family: 'code-indexer',
    providerId: 'gitnexus',
    toolVersion: '1.2.0',
    distribution: { source: 'npm:gitnexus', digest: `sha512:${'d'.repeat(128)}` },
    license: {
      name: 'PolyForm Noncommercial 1.0.0',
      spdx: 'PolyForm-Noncommercial-1.0.0',
      url: 'https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE',
      redistribution: 'conditional',
    },
    installerRecipeVersion: 'npm-prefix-v1',
    platform: { operatingSystem: 'linux', architecture: 'x64' },
    runtimes: [{ name: 'node', version: '24.11.0', abi: '137' }],
    grammars: ['typescript'],
    features: ['cli'],
    healthProbe: {
      executable: 'bin/gitnexus',
      args: ['--version'],
      expectedExitCode: 0,
      expectedOutput: '1.2.0',
    },
    ...overrides,
  };
}

function indexIdentity(overrides: Partial<CodeIndexArtifactIdentity> = {}): CodeIndexArtifactIdentity {
  return {
    version: 1,
    kind: 'code-index-snapshot',
    providerCompatibilityDigest: A,
    snapshotCompatibilityDigest: B,
    storageFormat: 'ladybug-v1',
    platform: { operatingSystem: 'linux', architecture: 'x64' },
    ...overrides,
  };
}

const files: readonly ArtifactFileEntry[] = [
  { path: 'bin/tool', digest: A, bytes: 4, mode: 0o755 },
  { path: 'share/config.json', digest: B, bytes: 8, mode: 0o644 },
];

describe('artifact-cache contracts', () => {
  it('parses exact tool identity, runtime, platform, probe, distribution, and license metadata', () => {
    const parsed = parseReviewToolDescriptor(descriptor());
    expect(parsed).toMatchObject({
      id: 'gitnexus',
      family: 'code-indexer',
      providerId: 'gitnexus',
      toolVersion: '1.2.0',
      installerRecipeVersion: 'npm-prefix-v1',
    });
    expect(reviewToolDescriptorDigest(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('invalidates tool identities when acquisition compatibility inputs change', () => {
    const base = reviewToolDescriptorDigest(descriptor());
    const variants = [
      descriptor({ toolVersion: '1.2.1' }),
      descriptor({ installerRecipeVersion: 'npm-prefix-v2' }),
      descriptor({ platform: { operatingSystem: 'linux', architecture: 'arm64' } }),
      descriptor({ runtimes: [{ name: 'node', version: '24.12.0', abi: '138' }] }),
      descriptor({ grammars: ['javascript', 'typescript'] }),
      descriptor({ distribution: { source: 'npm:gitnexus', digest: `sha512:${'e'.repeat(128)}` } }),
    ];
    for (const variant of variants) expect(reviewToolDescriptorDigest(variant)).not.toBe(base);
  });

  it('requires provider identity only for code-indexer tools', () => {
    const { providerId: _providerId, ...withoutProvider } = descriptor();
    expect(() => parseReviewToolDescriptor(withoutProvider)).toThrow('require providerId');
    expect(() => parseReviewToolDescriptor({
      ...withoutProvider,
      family: 'harness',
      providerId: 'unexpected',
    })).toThrow('must not declare providerId');
  });

  it('derives safe keys from complete immutable identities', () => {
    const base = indexIdentity();
    const key = artifactCacheKey(base);
    expect(key).toMatch(/^v1\/code-index-snapshot\/[0-9a-f]{64}$/u);
    expect(artifactIdentityDigest(base)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(artifactCacheKey(indexIdentity({ snapshotCompatibilityDigest: C }))).not.toBe(key);
    expect(artifactCacheKey(indexIdentity({ storageFormat: 'ladybug-v2' }))).not.toBe(key);
    expect(artifactCacheKey(indexIdentity({
      platform: { operatingSystem: 'linux', architecture: 'arm64' },
    }))).not.toBe(key);
  });

  it('requires sorted complete digest inputs for derived artifacts', () => {
    const parsed = parseArtifactIdentity({
      version: 1,
      kind: 'change-impact-map',
      contractVersion: '1',
      inputs: [
        { name: 'base-snapshot', digest: A },
        { name: 'head-snapshot', digest: B },
      ],
    });
    expect(parsed.kind).toBe('change-impact-map');
    expect(() => parseArtifactIdentity({
      version: 1,
      kind: 'context-plan',
      contractVersion: '1',
      inputs: [],
    })).toThrow('at least one input digest');
    expect(() => parseArtifactIdentity({
      version: 1,
      kind: 'context-plan',
      contractVersion: '1',
      inputs: [
        { name: 'z', digest: A },
        { name: 'a', digest: B },
      ],
    })).toThrow('must be sorted');
  });

  it('validates artifact manifests against their identity and exact file payload', () => {
    const identity = indexIdentity();
    const manifest = parseArtifactManifest({
      version: 1,
      key: artifactCacheKey(identity),
      identityDigest: artifactIdentityDigest(identity),
      identity,
      payloadDigest: artifactPayloadDigest(files),
      files,
      createdAtMs: 1_000,
      expiresAtMs: 2_000,
    });
    expect(manifest.files).toEqual(files);
    expect(() => parseArtifactManifest({ ...manifest, identityDigest: C })).toThrow('identityDigest does not match');
    expect(() => parseArtifactManifest({ ...manifest, payloadDigest: C })).toThrow('payloadDigest does not match');
    expect(() => parseArtifactManifest({ ...manifest, expiresAtMs: 999 })).toThrow('must follow createdAtMs');
  });

  it('rejects unsafe paths, unsorted files, and invalid executable manifests', () => {
    const identity = indexIdentity();
    const base = {
      version: 1,
      key: artifactCacheKey(identity),
      identityDigest: artifactIdentityDigest(identity),
      identity,
      payloadDigest: artifactPayloadDigest(files),
      files,
      createdAtMs: 1,
    };
    expect(() => parseArtifactManifest({
      ...base,
      files: [{ ...files[0], path: '../escape' }],
      payloadDigest: A,
    })).toThrow('normalized relative path');
    expect(() => parseArtifactManifest({
      ...base,
      files: [...files].reverse(),
    })).toThrow('must be sorted');
    expect(() => parseInstalledToolManifest({
      version: 1,
      descriptorDigest: A,
      payloadDigest: artifactPayloadDigest(files),
      files,
      executablePaths: ['share/config.json'],
    })).toThrow('lacks execute permission');
  });

  it('requires at least one positive retention bound', () => {
    expect(parseArtifactRetentionPolicy({ maxAgeMs: 1_000, maxEntries: 10 })).toEqual({
      maxAgeMs: 1_000,
      maxEntries: 10,
    });
    expect(() => parseArtifactRetentionPolicy({})).toThrow('requires at least one bound');
    expect(() => parseArtifactRetentionPolicy({ maxBytes: 0 })).toThrow('must be positive');
  });
});
