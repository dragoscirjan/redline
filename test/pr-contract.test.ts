import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadReviewBundle } from '../src/review/bundle.js';
import type { LoadedReviewCodeContext } from '../src/review/indexed-context.js';
import {
  buildPullRequestReview,
  derivePullRequestVerdict,
  validateFindingReferences,
} from '../src/review/pr-contract.js';
import { graphReferenceDigest, parseFileReviewDocument } from '../src/review/report.js';
import type {
  FileReviewRecord,
  GraphReference,
  PullRequestFinding,
  ValidatedFinding,
} from '../src/review/types.js';
import { createBundleFixture, BASE_SHA, HEAD_SHA } from './helpers/bundle.js';
import { publishedFinding, pullRequestReview, reviewFinding } from './helpers/finding.js';

function context(
  overrides: Partial<LoadedReviewCodeContext['coverage']> = {},
  graphReferences: readonly GraphReference[] = [graphReference()],
): LoadedReviewCodeContext {
  return {
    coverage: {
      status: 'complete',
      provider: { id: 'cgc', version: '0.5.7' },
      revision: HEAD_SHA,
      relatedSpans: 1,
      sourceBytes: 12,
      reason: null,
      filesWithContext: 1,
      cache: 'built',
      timings: null,
      diagnosticCodes: [],
      ...overrides,
    },
    files: new Map(),
    diagnostics: [],
    timings: null,
    graphSnapshotRevision: BASE_SHA,
    graphFactDigests: new Set(graphReferences.map((reference) => reference.graphFactDigest)),
  };
}

function validatedFinding(overrides: Partial<ValidatedFinding> = {}): ValidatedFinding {
  return { ...reviewFinding(), id: 'f-contract', ...overrides };
}

function graphReference(overrides: Partial<GraphReference> = {}): GraphReference {
  const fact = {
    provider: 'cgc',
    providerVersion: '0.5.7',
    snapshotRevision: BASE_SHA,
    capability: 'related-spans',
    query: 'changed-symbol:example',
    relationship: 'caller invokes changed symbol',
    resolution: 'exact' as const,
    ...overrides,
  };
  return { ...fact, graphFactDigest: graphReferenceDigest(fact) };
}

function prFinding(overrides: Partial<PullRequestFinding> = {}): PullRequestFinding {
  return {
    ...publishedFinding(),
    triggerFileId: '000001',
    triggerPath: 'src/example.ts',
    ...overrides,
  };
}

describe('PR finding evidence validation', () => {
  it('retains cross-file head evidence and rejects a mismatched location independently', async () => {
    const fixture = await createBundleFixture();
    try {
      await writeFile(join(fixture.source, 'src', 'caller.ts'), 'export const caller = invoke();\n');
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const support = {
        role: 'caller-assumption' as const,
        revision: HEAD_SHA,
        path: 'src/caller.ts',
        startLine: 1,
        endLine: 1,
        evidence: 'export const caller = invoke();',
      };
      const finding = validatedFinding({
        supportingEvidence: [support],
        impactPath: {
          status: 'complete',
          steps: [{
            from: 'src/example.ts',
            to: 'src/caller.ts',
            relationship: 'caller relies on changed behavior',
            evidence: 'source',
            referenceIndex: 0,
          }],
        },
      });
      await expect(validateFindingReferences(bundle, finding, context())).resolves.toBe(finding);
      await expect(validateFindingReferences(
        bundle,
        { ...finding, supportingEvidence: [{ ...support, evidence: 'invented source' }] },
        context(),
      )).rejects.toThrow(/does not match captured source/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('validates base evidence for a renamed or deleted path from captured base source', async () => {
    const fixture = await createBundleFixture({
      manifestOverrides: {
        status: 'R',
        oldPath: 'src/old-name.ts',
        newPath: 'src/new-name.ts',
        similarity: 100,
      },
    });
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const finding = validatedFinding({
        side: 'LEFT',
        evidence: 'old',
        supportingEvidence: [{
          role: 'contract',
          revision: BASE_SHA,
          path: 'src/old-name.ts',
          startLine: 1,
          endLine: 1,
          evidence: 'old',
        }],
      });
      await expect(validateFindingReferences(bundle, finding, context())).resolves.toBe(finding);
    } finally {
      await fixture.cleanup();
    }
  });

  it('validates supporting evidence for a deleted file against captured base source', async () => {
    const fixture = await createBundleFixture({
      manifestOverrides: {
        status: 'D',
        oldPath: 'src/deleted.ts',
        newPath: null,
      },
    });
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const finding = validatedFinding({
        side: 'LEFT',
        evidence: 'old',
        supportingEvidence: [{
          role: 'impact-path',
          revision: BASE_SHA,
          path: 'src/deleted.ts',
          startLine: 1,
          endLine: 1,
          evidence: 'old',
        }],
      });
      await expect(validateFindingReferences(bundle, finding, context())).resolves.toBe(finding);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts exact base graph identities and rejects head snapshots or provider disagreement', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const accepted = validatedFinding({
        graphReferences: [graphReference()],
        impactPath: {
          status: 'complete',
          steps: [{
            from: 'changed symbol',
            to: 'caller',
            relationship: 'provider-derived call edge',
            evidence: 'graph',
            referenceIndex: 0,
          }],
        },
      });
      await expect(validateFindingReferences(bundle, accepted, context())).resolves.toBe(accepted);

      const headReference = graphReference({ snapshotRevision: HEAD_SHA });
      await expect(validateFindingReferences(
        bundle,
        { ...accepted, graphReferences: [headReference] },
        context(),
      )).rejects.toThrow(/base provider snapshot/u);

      const otherProvider = graphReference({ provider: 'gitnexus', providerVersion: '1.6.12' });
      await expect(validateFindingReferences(
        bundle,
        { ...accepted, graphReferences: [otherProvider] },
        context(),
      )).rejects.toThrow(/base provider snapshot/u);

      const invented = graphReference({ query: 'changed-symbol:invented' });
      await expect(validateFindingReferences(
        bundle,
        { ...accepted, graphReferences: [invented] },
        context(),
      )).rejects.toThrow(/not an action-produced fact/u);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('candidate isolation and impact-path parsing', () => {
  it('keeps a valid v3 candidate when a sibling graph digest is malformed', () => {
    const valid = reviewFinding();
    const graph = graphReference();
    const invalid = {
      ...reviewFinding({
        graphReferences: [graph],
        impactPath: {
          status: 'complete',
          steps: [{
            from: 'changed symbol',
            to: 'caller',
            relationship: 'call edge',
            evidence: 'graph',
            referenceIndex: 0,
          }],
        },
      }),
      graphReferences: [{ ...graph, graphFactDigest: `sha256:${'0'.repeat(64)}` }],
    };
    const parsed = parseFileReviewDocument(JSON.stringify({
      version: 3,
      fileId: '000001',
      outcome: 'findings',
      findings: [valid, invalid],
    }));
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.candidateIndices).toEqual([0]);
    expect(parsed.rejectedCandidates).toHaveLength(1);
    expect(parsed.rejectedCandidates[0]).toMatchObject({ index: 1, stage: 'parse', code: 'candidate-schema-invalid' });
  });
});

describe('deterministic PR verdict and coverage', () => {
  it('derives all verdict classes without accepting model prose', () => {
    const complete = pullRequestReview().coverage;
    expect(derivePullRequestVerdict([], complete).status).toBe('mergeable');
    expect(derivePullRequestVerdict(
      [prFinding({ classification: 'defect', verification: { status: 'unverified', reason: 'not run' } })],
      complete,
    ).status).toBe('blocked');
    expect(derivePullRequestVerdict(
      [prFinding({ classification: 'risk', verification: { status: 'unverified', reason: 'not run' } })],
      complete,
    ).status).toBe('human-decision-required');
    expect(derivePullRequestVerdict(
      [prFinding({
        verification: { status: 'confirmed', reason: 'independently reproduced' },
        remediationStatus: 'verified',
      })],
      complete,
    ).status).toBe('mergeable-after-verified-fixes');
    expect(derivePullRequestVerdict([], {
      ...complete,
      files: { ...complete.files, status: 'incomplete', reason: 'one required file omitted' },
    }).status).toBe('inconclusive');
  });

  it('marks confirmed critical budget exhaustion as required while keeping noncritical truncation advisory', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const environment = { harness: 'echo' as const, findingScope: 'defects' as const,
        model: { provider: 'mock', endpoint: 'http://127.0.0.1', model: 'test-model', auth: undefined } };
      const records: FileReviewRecord[] = Array.from({ length: 26 }, (_value, index) => {
        const fileId = String(index + 1).padStart(6, '0');
        return { version: 4, fileId, path: `src/${fileId}.ts`, status: 'M', harness: 'echo',
          model: 'test-model', codeContext: context().coverage, outcome: 'findings',
          findings: [publishedFinding({ id: `f-${fileId}`, rootCause: `independent cause ${fileId}`,
            severity: 'critical', verification: { status: 'confirmed', reason: 'checked' } })],
          verification: { status: 'completed', requested: 1, accepted: 1, rejected: 0, durationMs: 1 },
          rejectedCandidates: [], durationMs: 1 };
      });
      const critical = buildPullRequestReview({ bundle, environment, records, indexedContext: context(), synthesize: true });
      expect(critical.synthesis?.decisions.filter((item) => item.status === 'publish')).toHaveLength(25);
      expect(critical.synthesis?.decisions.filter((item) => item.status === 'file-budget')).toHaveLength(1);
      expect(critical.limitations).toContainEqual(expect.objectContaining({
        code: 'critical-publication-suppressed', required: true,
      }));
      expect(critical.coverage.publication).toMatchObject({ status: 'incomplete', required: true });
      const noncritical = buildPullRequestReview({ bundle, environment,
        records: records.map((record) => ({ ...record, findings: record.findings.map((finding) => ({
          ...finding, severity: 'medium' as const,
        })) })), indexedContext: context(), synthesize: true });
      expect(noncritical.limitations).toContainEqual(expect.objectContaining({
        code: 'publication-truncated', required: false,
      }));
      expect(noncritical.limitations.some((item) => item.code === 'critical-publication-suppressed')).toBe(false);
      expect(noncritical.coverage.publication).toMatchObject({ status: 'completed', required: false });
    } finally {
      await fixture.cleanup();
    }
  });

  it('records exact snapshots, unavailable inspections, bounded graph work, and one cross-file finding', async () => {
    const fixture = await createBundleFixture();
    try {
      const bundle = await loadReviewBundle(fixture.review, fixture.source);
      const finding = publishedFinding({
        id: 'f-cross-file',
        supportingEvidence: [{
          role: 'impact-path',
          revision: HEAD_SHA,
          path: 'src/other.ts',
          startLine: 1,
          endLine: 1,
          evidence: 'caller();',
        }],
      });
      const record: FileReviewRecord = {
        version: 4,
        fileId: '000001',
        path: 'src/example.ts',
        status: 'M',
        harness: 'echo',
        model: 'test-model',
        codeContext: {
          status: 'complete',
          provider: { id: 'cgc', version: '0.5.7' },
          revision: HEAD_SHA,
          relatedSpans: 1,
          sourceBytes: 12,
          reason: null,
        },
        outcome: 'findings',
        findings: [finding],
        rejectedCandidates: [],
        durationMs: 1,
      };
      const review = buildPullRequestReview({
        bundle,
        environment: {
          harness: 'echo',
          model: { provider: 'mock', endpoint: 'http://127.0.0.1', model: 'test-model', auth: undefined },
          findingScope: 'defects',
        },
        records: [record],
        indexedContext: context(),
      });
      expect(review.findings).toHaveLength(1);
      expect(review.findings[0]?.supportingEvidence[0]?.path).toBe('src/other.ts');
      expect(review.coverage.codeIntelligence).toMatchObject({
        status: 'completed',
        baseSnapshot: BASE_SHA,
        headSnapshot: HEAD_SHA,
        capabilities: ['related-spans'],
      });
      expect(review.coverage.graphQueries[0]?.status).toBe('completed');
      expect(review.coverage.impactTraversals[0]?.status).toBe('completed');
      expect(review.coverage.relationships).toMatchObject({ sourceConfirmed: 1, providerDerived: 1 });
      expect(review.coverage.inspections.every((inspection) => inspection.status === 'unavailable')).toBe(true);

      const unavailableContext = context({
        status: 'unavailable',
        provider: null,
        revision: null,
        relatedSpans: 0,
        sourceBytes: 0,
        reason: 'artifact-unavailable',
        filesWithContext: 0,
      });
      const degraded = buildPullRequestReview({
        bundle,
        environment: {
          harness: 'echo',
          model: { provider: 'mock', endpoint: 'http://127.0.0.1', model: 'test-model', auth: undefined },
          findingScope: 'defects',
        },
        records: [{
          ...record,
          codeContext: {
            status: 'unavailable',
            provider: null,
            revision: null,
            relatedSpans: 0,
            sourceBytes: 0,
            reason: 'artifact-unavailable',
          },
        }],
        indexedContext: unavailableContext,
      });
      expect(degraded.coverage.codeIntelligence).toMatchObject({
        status: 'unavailable',
        capabilities: [],
      });
      expect(degraded.coverage.graphQueries[0]?.status).toBe('unavailable');
      expect(degraded.limitations).toContainEqual(expect.objectContaining({ code: 'indexed-context-degraded' }));
    } finally {
      await fixture.cleanup();
    }
  });
});
