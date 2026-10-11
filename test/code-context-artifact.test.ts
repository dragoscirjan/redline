import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CODE_CONTEXT_ARTIFACT_BYTES,
  loadCodeContextArtifact,
  parseCodeContextArtifact,
} from '../src/code-context/artifact.js';

function validArtifact(): Record<string, unknown> {
  return {
    version: 1,
    provider: { id: 'cgc', version: '0.5.7' },
    repository: 'owner/repository',
    revision: 'a'.repeat(40),
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
    expect(parsed.files[0]?.related[0]).toEqual({
      path: 'src/user-service.ts',
      startLine: 3,
      endLine: 5,
      reason: 'related-symbol-calls-changed-code',
    });
    expect(parsed.timings.saveMs).toBeNull();
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
