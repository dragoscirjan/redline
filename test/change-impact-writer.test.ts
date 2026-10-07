import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveChangeImpact } from '../src/change-impact/planner.js';
import { createChangeImpactWriter } from '../src/change-impact/writer.js';
import type { ChangeImpactInput } from '../src/change-impact/types.js';

const input: ChangeImpactInput = {
  baseRevision: 'a'.repeat(40),
  headRevision: 'b'.repeat(40),
  intent: { summary: 'Keep the fallback reviewable.', acceptanceCriteria: ['Do not require an index.'] },
  changedTargets: [
    {
      id: 'target-1',
      fileId: '000001',
      status: 'M',
      oldPath: 'src/example.ts',
      newPath: 'src/example.ts',
      changedLines: [2],
    },
  ],
  contextCandidates: [
    {
      id: 'diff-1',
      category: 'diff-declaration',
      path: 'src/example.ts',
      revision: 'head',
      span: { startLine: 1, endLine: 4 },
      content: '-return oldValue;\n+return newValue;',
      digest: 'sha256:diff-1',
      selectionReason: 'Authoritative changed declaration',
      nodeIds: [],
      targetIds: ['target-1'],
      ambiguous: false,
      truncated: false,
    },
  ],
  questions: [
    {
      id: 'correctness',
      specialist: 'design-maintainability',
      targetIds: ['target-1'],
      byteBudget: 1_024,
      tokenBudget: 512,
    },
  ],
  configuration: {
    mode: 'file-only',
    traversal: {
      maxDepth: 2,
      maxFanOut: 4,
      maxNodes: 8,
      maxEdges: 8,
      maxBytes: 8_192,
      maxDurationMs: 1_000,
      maxWitnesses: 4,
    },
  },
};

describe('createChangeImpactWriter', () => {
  it('persists versioned JSON and human-readable impact artifacts', async () => {
    const output = await mkdtemp(join(tmpdir(), 'redline-impact-writer-'));
    try {
      const result = deriveChangeImpact(input, { monotonicNow: () => 0 });
      const writer = createChangeImpactWriter(output);
      await Promise.all([
        writer.writeImpactMap(result.impactMap),
        writer.writeImpactMap(result.impactMap),
      ]);
      await writer.writeContextPlan(result.contextPlan);

      const impactJson = JSON.parse(await readFile(join(output, 'impact', 'change-impact.json'), 'utf8')) as {
        version: number;
        mode: string;
        coverage: string;
      };
      expect(impactJson).toMatchObject({ version: 1, mode: 'file-only', coverage: 'unavailable' });

      const contextJson = JSON.parse(await readFile(join(output, 'impact', 'context-plan.json'), 'utf8')) as {
        version: number;
        questions: Array<{ items: Array<{ selectionReason: string }> }>;
      };
      expect(contextJson.version).toBe(1);
      expect(contextJson.questions[0]?.items[0]?.selectionReason).toBe('Authoritative changed declaration');

      const impactMarkdown = await readFile(join(output, 'impact', 'change-impact.md'), 'utf8');
      expect(impactMarkdown).toContain('# Change impact map');
      expect(impactMarkdown).toContain('Graph relationships are derived evidence.');
      expect(impactMarkdown).toContain('planning signals, not findings');

      const contextMarkdown = await readFile(join(output, 'impact', 'context-plan.md'), 'utf8');
      expect(contextMarkdown).toContain('# Review context plan');
      expect(contextMarkdown).toContain('Authoritative changed declaration');
      expect(contextMarkdown).toContain('captured source');
      expect((await readdir(join(output, 'impact'))).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
