import { createHash } from 'node:crypto';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CODE_CONTEXT_ARTIFACT_BYTES,
  codeContextGraphFactDigest,
  loadCodeContextArtifact,
  parseCodeContextArtifact,
} from '../src/code-context/artifact.ts';

function validArtifact(): Record<string, unknown> {
  const graphFact = {
    provider: 'cgc',
    providerVersion: '0.5.7',
    snapshotRevision: 'b'.repeat(40),
    capability: 'related-spans',
    query: `related-span:sha256:${createHash('sha256')
      .update(JSON.stringify(['src/cache.ts', 'src/user-service.ts', 3, 5]), 'utf8')
      .digest('hex')}`,
    relationship: 'related-symbol-calls-changed-code',
    resolution: 'exact' as const,
  };
  return {
    version: 1,
    provider: { id: 'cgc', version: '0.5.7' },
    repository: 'owner/repository',
    revision: 'a'.repeat(40),
    baseRevision: 'b'.repeat(40),
    status: 'complete',
    files: [
      {
        changedPath: 'src/cache.ts',
        status: 'complete',
        related: [
          {
            path: 'src/user-service.ts',
            startLine: 3,
            endLine: 5,
            reason: 'related-symbol-calls-changed-code',
            graphReference: {
              ...graphFact,
              graphFactDigest: codeContextGraphFactDigest(graphFact),
            },
          },
        ],
      },
    ],
    diagnostics: [],
    timings: {
      installationMs: 12,
      restoreMs: 3,
      indexMs: 40,
      queryMs: 5,
      saveMs: null,
    },
  };
}

describe('code-context artifact', () => {
  it('parses exact provider provenance, per-file coverage, spans, and timings', () => {
    const parsed = parseCodeContextArtifact(validArtifact());
    expect(parsed.provider).toEqual({ id: 'cgc', version: '0.5.7' });
    expect(parsed.baseRevision).toBe('b'.repeat(40));
    expect(parsed.files[0]?.related[0]).toMatchObject({
      path: 'src/user-service.ts',
      startLine: 3,
      endLine: 5,
      reason: 'related-symbol-calls-changed-code',
      graphReference: {
        provider: 'cgc',
        snapshotRevision: 'b'.repeat(40),
        capability: 'related-spans',
      },
    });
    expect(parsed.timings.validationMs).toBeUndefined();
    expect(parsed.timings.saveMs).toBeNull();
  });

  it('requires separate validation timing in version 2 while retaining version 1 compatibility', () => {
    const current = structuredClone(validArtifact());
    current['version'] = 2;
    const timings = current['timings'] as Record<string, unknown>;
    timings['validationMs'] = 7;
    expect(parseCodeContextArtifact(current).timings.validationMs).toBe(7);

    delete timings['validationMs'];
    expect(() => parseCodeContextArtifact(current)).toThrow('validationMs is required in version 2');
  });

  it('rejects unknown fields and non-normalized source paths', () => {
    expect(() => parseCodeContextArtifact({ ...validArtifact(), graphDatabase: {} })).toThrow(
      'contains unsupported fields',
    );
    const invalid = structuredClone(validArtifact());
    const files = invalid['files'] as Array<Record<string, unknown>>;
    const related = files[0]?.['related'] as Array<Record<string, unknown>>;
    related[0]!['path'] = '../outside.ts';
    expect(() => parseCodeContextArtifact(invalid)).toThrow('normalized repository-relative path');
  });

  it('rejects graph facts that were altered or do not match the provider snapshot', () => {
    const altered = structuredClone(validArtifact());
    const alteredFiles = altered['files'] as Array<Record<string, unknown>>;
    const alteredRelated = alteredFiles[0]?.['related'] as Array<Record<string, unknown>>;
    const alteredReference = alteredRelated[0]?.['graphReference'] as Record<string, unknown>;
    alteredReference['relationship'] = 'invented-relationship';
    expect(() => parseCodeContextArtifact(altered)).toThrow('does not match the graph fact identity');

    const forged = structuredClone(validArtifact());
    const forgedFiles = forged['files'] as Array<Record<string, unknown>>;
    const forgedRelated = forgedFiles[0]?.['related'] as Array<Record<string, unknown>>;
    const forgedReference = forgedRelated[0]?.['graphReference'] as Record<string, unknown>;
    forgedReference['query'] = `related-span:sha256:${'d'.repeat(64)}`;
    const { graphFactDigest: _digest, ...forgedFact } = forgedReference;
    forgedReference['graphFactDigest'] = codeContextGraphFactDigest(forgedFact as never);
    expect(() => parseCodeContextArtifact(forged)).toThrow('does not identify the exact related span');

    const wrongBase = structuredClone(validArtifact());
    wrongBase['baseRevision'] = 'd'.repeat(40);
    expect(() => parseCodeContextArtifact(wrongBase)).toThrow('does not match its provider base snapshot');
  });

  it('accepts legacy v1 spans without graph provenance but cannot manufacture it', () => {
    const legacy = structuredClone(validArtifact());
    delete legacy['baseRevision'];
    const files = legacy['files'] as Array<Record<string, unknown>>;
    const related = files[0]?.['related'] as Array<Record<string, unknown>>;
    delete related[0]?.['graphReference'];
    expect(parseCodeContextArtifact(legacy).baseRevision).toBeUndefined();
  });

  it('rejects invalid, oversized, duplicate, and unsorted spans', () => {
    const oversized = structuredClone(validArtifact());
    const oversizedFiles = oversized['files'] as Array<Record<string, unknown>>;
    const oversizedRelated = oversizedFiles[0]?.['related'] as Array<Record<string, unknown>>;
    oversizedRelated[0]!['endLine'] = 83;
    expect(() => parseCodeContextArtifact(oversized)).toThrow('exceeds the line limit');

    const duplicate = structuredClone(validArtifact());
    const duplicateFiles = duplicate['files'] as Array<Record<string, unknown>>;
    const duplicateRelated = duplicateFiles[0]?.['related'] as Array<Record<string, unknown>>;
    duplicateRelated.push(structuredClone(duplicateRelated[0]!));
    expect(() => parseCodeContextArtifact(duplicate)).toThrow('must be sorted and unique');

    const unsorted = structuredClone(validArtifact());
    const unsortedFiles = unsorted['files'] as Array<Record<string, unknown>>;
    unsortedFiles.push({ changedPath: 'README.md', status: 'unsupported', related: [] });
    unsorted['status'] = 'partial';
    expect(() => parseCodeContextArtifact(unsorted)).toThrow('code-context.files must be sorted and unique');
  });

  it('requires top-level status to agree with per-file coverage', () => {
    expect(() => parseCodeContextArtifact({ ...validArtifact(), status: 'unavailable' })).toThrow(
      'status does not match per-file coverage',
    );
    const mixed = structuredClone(validArtifact());
    const files = mixed['files'] as Array<Record<string, unknown>>;
    files[0]!['status'] = 'partial';
    mixed['status'] = 'partial';
    expect(parseCodeContextArtifact(mixed).status).toBe('partial');

    expect(parseCodeContextArtifact({
      ...validArtifact(),
      status: 'unavailable',
      files: [],
    }).status).toBe('unavailable');
    expect(parseCodeContextArtifact({ ...validArtifact(), status: 'partial' }).status).toBe('partial');
  });

  it('loads only bounded regular files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'redline-code-context-'));
    const artifactPath = join(directory, 'code-context.json');
    await writeFile(artifactPath, `${JSON.stringify(validArtifact())}\n`);
    await expect(loadCodeContextArtifact(artifactPath)).resolves.toMatchObject({ status: 'complete' });

    const linkPath = join(directory, 'linked.json');
    await symlink(artifactPath, linkPath);
    await expect(loadCodeContextArtifact(linkPath)).rejects.toThrow('regular file, not a symlink');

    const oversizedPath = join(directory, 'oversized.json');
    await writeFile(oversizedPath, 'x'.repeat(MAX_CODE_CONTEXT_ARTIFACT_BYTES + 1));
    await expect(loadCodeContextArtifact(oversizedPath)).rejects.toThrow('exceeds the byte limit');
  });
});
