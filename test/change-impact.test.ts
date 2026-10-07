import { describe, expect, it } from 'vitest';
import { deriveChangeImpact } from '../src/change-impact/planner.js';
import type {
  ChangeImpactInput,
  CodeIntelligenceSnapshot,
  ContextCandidate,
  FactProvenance,
  GraphEdge,
  GraphNode,
  ImpactConfiguration,
} from '../src/change-impact/types.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function provenance(side: 'base' | 'head', queryId = 'fixture-query'): FactProvenance {
  return {
    provider: side === 'base' ? 'provider-a' : 'provider-b',
    providerVersion: '1.2.3',
    snapshotId: `${side}-snapshot`,
    revision: side === 'base' ? BASE : HEAD,
    queryId,
    status: 'complete',
  };
}

function node(
  side: 'base' | 'head',
  id: string,
  path: string,
  roles: GraphNode['roles'] = [],
  overrides: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    kind: 'function',
    name: id,
    path,
    span: { startLine: 1, endLine: 5 },
    digest: `${side}-${id}`,
    roles,
    provenance: provenance(side),
    ...overrides,
  };
}

function edge(
  side: 'base' | 'head',
  id: string,
  kind: string,
  from: string,
  to: string,
  overrides: Partial<GraphEdge> = {},
): GraphEdge {
  return { id, kind, from, to, provenance: provenance(side), ...overrides };
}

function snapshot(
  side: 'base' | 'head',
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  overrides: Partial<CodeIntelligenceSnapshot> = {},
): CodeIntelligenceSnapshot {
  return {
    version: 1,
    id: `${side}-snapshot`,
    revision: side === 'base' ? BASE : HEAD,
    provider: side === 'base' ? 'provider-a' : 'provider-b',
    providerVersion: '1.2.3',
    coverage: 'complete',
    capabilities: ['calls', 'contracts', 'tests'],
    nodes,
    edges,
    uncertainty: [],
    ...overrides,
  };
}

const configuration: ImpactConfiguration = {
  mode: 'full-impact',
  traversal: {
    maxDepth: 4,
    maxFanOut: 8,
    maxNodes: 20,
    maxEdges: 30,
    maxBytes: 64 * 1024,
    maxDurationMs: 1_000,
    maxWitnesses: 8,
  },
};

function fixture(): ChangeImpactInput {
  const baseNodes = [
    node('base', 'api', 'src/api.ts', ['entry-point', 'contract'], { name: 'handle', public: true, signature: 'handle(v1)' }),
    node('base', 'service', 'src/service.ts', ['state-write']),
    node('base', 'test', 'test/api.test.ts', ['test']),
    node('base', 'removed-helper', 'src/old.ts'),
  ];
  const headNodes = [
    node('head', 'api', 'src/api.ts', ['entry-point', 'contract'], { name: 'handleV2', public: true, signature: 'handle(v2)' }),
    node('head', 'service', 'src/service.ts', ['state-write']),
    node('head', 'test', 'test/api.test.ts', ['test']),
    node('head', 'external', 'src/client.ts', ['external-call']),
    node('head', 'database', 'src/database.ts', ['persistent-state']),
    node('head', 'implementation', 'src/implementation.ts'),
  ];
  const baseEdges = [
    edge('base', 'calls-service', 'calls', 'api', 'service'),
    edge('base', 'tests-api', 'tests', 'test', 'api'),
    edge('base', 'calls-old', 'calls', 'api', 'removed-helper'),
  ];
  const headEdges = [
    edge('head', 'calls-service', 'calls', 'api', 'service'),
    edge('head', 'tests-api', 'tests', 'test', 'api'),
    edge('head', 'calls-external', 'calls', 'api', 'external', { approximate: true }),
    edge('head', 'calls-database', 'calls', 'service', 'database'),
    edge('head', 'implements-api', 'implements', 'implementation', 'api'),
  ];
  const candidates: ContextCandidate[] = [
    {
      id: 'diff',
      category: 'diff-declaration',
      path: 'src/api.ts',
      revision: 'head',
      span: { startLine: 1, endLine: 5 },
      content: 'diff context',
      digest: 'sha256:diff',
      selectionReason: 'Changed declaration for api',
      nodeIds: ['api'],
      targetIds: ['target-api'],
      ambiguous: false,
      truncated: false,
    },
    {
      id: 'witness',
      category: 'path-witness',
      path: 'src/client.ts',
      revision: 'head',
      content: 'external call witness',
      digest: 'sha256:witness',
      selectionReason: 'Shortest path from api to external effect',
      provenance: provenance('head', 'impact-path'),
      nodeIds: ['api', 'external'],
      targetIds: ['target-api'],
      ambiguous: false,
      truncated: false,
    },
    {
      id: 'requirements',
      category: 'requirements-guidance',
      path: '.redline/requirements.md',
      revision: 'repository',
      content: 'Preserve backwards compatibility.',
      digest: 'sha256:requirements',
      selectionReason: 'Repository requirement applies to public APIs',
      nodeIds: [],
      targetIds: [],
      ambiguous: false,
      truncated: false,
    },
    {
      id: 'unrelated',
      category: 'secondary-graph',
      path: 'src/unrelated.ts',
      revision: 'head',
      content: 'must not be selected',
      digest: 'sha256:unrelated',
      selectionReason: 'Different change neighborhood',
      provenance: provenance('head', 'secondary'),
      nodeIds: ['unrelated'],
      targetIds: ['target-other'],
      ambiguous: false,
      truncated: false,
    },
  ];
  return {
    baseRevision: BASE,
    headRevision: HEAD,
    intent: { summary: 'Version the public handler', acceptanceCriteria: ['Existing clients remain compatible.'] },
    changedTargets: [
      {
        id: 'target-api',
        fileId: '000001',
        status: 'M',
        oldPath: 'src/api.ts',
        newPath: 'src/api.ts',
        baseNodeId: 'api',
        headNodeId: 'api',
        changedLines: [2],
      },
      {
        id: 'target-service',
        fileId: '000002',
        status: 'M',
        oldPath: 'src/service.ts',
        newPath: 'src/service.ts',
        baseNodeId: 'service',
        headNodeId: 'service',
        changedLines: [3],
      },
      {
        id: 'target-other',
        fileId: '000003',
        status: 'A',
        oldPath: null,
        newPath: 'src/other.ts',
      },
    ],
    baseSnapshot: snapshot('base', baseNodes, baseEdges),
    headSnapshot: snapshot('head', headNodes, headEdges, {
      uncertainty: [
        { code: 'dynamic-dispatch', message: 'Runtime registration may add callers.', nodeId: 'api' },
        { code: 'provider-disagreement', message: 'Providers disagree on one indirect caller.', queryId: 'impact-path' },
      ],
    }),
    contextCandidates: candidates,
    questions: [
      {
        id: 'compatibility-question',
        specialist: 'compatibility',
        targetIds: ['target-api'],
        byteBudget: 1_024,
        tokenBudget: 512,
      },
    ],
    configuration,
  };
}

const frozenClock = (): number => 0;

describe('deriveChangeImpact', () => {
  it('compares both revisions and preserves additions, removals, renames, and uncertainty', () => {
    const result = deriveChangeImpact(fixture(), { monotonicNow: frozenClock });

    expect(result.impactMap.version).toBe(1);
    expect(result.impactMap.graphDelta.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'api', kind: 'renamed' }),
      expect.objectContaining({ id: 'removed-helper', kind: 'removed' }),
      expect.objectContaining({ id: 'external', kind: 'added' }),
    ]));
    expect(result.impactMap.graphDelta.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'calls-old', kind: 'removed' }),
      expect.objectContaining({ id: 'calls-external', kind: 'added' }),
      expect.objectContaining({ id: 'implements-api', kind: 'added' }),
    ]));
    expect(result.impactMap.contractSurface.changedNodeIds).toContain('api');
    expect(result.impactMap.uncertainty.map((item) => item.code)).toEqual(expect.arrayContaining([
      'ambiguous-identity',
      'dynamic-behavior',
      'provider-disagreement',
    ]));
    expect(result.impactMap.coverage).toBe('partial');
  });

  it('clusters graph-related changes across files but does not join unrelated changes in one file', () => {
    const input = fixture();
    const result = deriveChangeImpact(input, { monotonicNow: frozenClock });

    expect(result.impactMap.neighborhoods).toHaveLength(2);
    expect(result.impactMap.neighborhoods[0]?.targetIds).toEqual(['target-api', 'target-service']);
    expect(result.impactMap.neighborhoods[0]?.paths).toEqual(['src/api.ts', 'src/service.ts']);
    expect(result.impactMap.neighborhoods[1]?.targetIds).toEqual(['target-other']);
    expect(result.impactMap.neighborhoods[1]?.partial).toBe(true);
  });

  it('derives bounded cones, shortest witnesses, state effects, tests, and routing inputs', () => {
    const result = deriveChangeImpact(fixture(), { monotonicNow: frozenClock });
    const apiDownstream = result.impactMap.cones.find(
      (cone) => cone.targetId === 'target-api' && cone.kind === 'downstream',
    );
    const apiTests = result.impactMap.testReachability.find((item) => item.targetId === 'target-api');

    expect(apiDownstream?.nodeIds).toEqual(expect.arrayContaining(['external', 'service']));
    expect(apiDownstream?.witnesses).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeIds: ['api', 'external'], approximate: true }),
      expect.objectContaining({ nodeIds: ['api', 'service'] }),
    ]));
    expect(result.impactMap.stateEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: 'target-api', nodeId: 'external', role: 'external-call' }),
      expect.objectContaining({ targetId: 'target-api', nodeId: 'service', role: 'state-write' }),
    ]));
    expect(apiTests?.status).toBe('discovered');
    expect(apiTests?.testNodeIds).toEqual(['test']);
    expect(result.impactMap.risk.specialistDimensions).toEqual(expect.arrayContaining([
      'compatibility',
      'data-integrity-concurrency',
      'reliability-recovery',
    ]));
  });

  it('packs only question-relevant context in the mandated category order', () => {
    const result = deriveChangeImpact(fixture(), { monotonicNow: frozenClock });
    const plan = result.contextPlan.questions[0];

    expect(plan?.items.map((item) => item.id)).toEqual(['diff', 'witness', 'requirements']);
    expect(plan?.items.map((item) => item.selectionReason)).toEqual([
      'Changed declaration for api',
      'Shortest path from api to external effect',
      'Repository requirement applies to public APIs',
    ]);
    expect(plan?.items.find((item) => item.id === 'witness')?.provenance?.queryId).toBe('impact-path');
    expect(plan?.items.some((item) => item.id === 'unrelated')).toBe(false);
  });

  it('is deterministic for identical normalized inputs and configuration', () => {
    const first = deriveChangeImpact(fixture(), { monotonicNow: frozenClock });
    const second = deriveChangeImpact(fixture(), { monotonicNow: frozenClock });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('records candidates omitted by independent byte and token budgets', () => {
    const input = fixture();
    const diffBytes = Buffer.byteLength('diff context', 'utf8');
    const limited: ChangeImpactInput = {
      ...input,
      questions: [{
        ...input.questions[0]!,
        byteBudget: diffBytes,
        tokenBudget: Math.ceil(diffBytes / 4),
      }],
    };
    const plan = deriveChangeImpact(limited, { monotonicNow: frozenClock }).contextPlan.questions[0];
    expect(plan?.items.map((item) => item.id)).toEqual(['diff']);
    expect(plan?.omittedCandidateIds).toEqual(['witness', 'requirements']);
    expect(plan?.coverage).toBe('partial');
  });

  it.each([
    ['depth', { maxDepth: 1 }, frozenClock],
    ['fan-out', { maxFanOut: 1 }, frozenClock],
    ['nodes', { maxNodes: 1 }, frozenClock],
    ['edges', { maxEdges: 1 }, frozenClock],
    ['bytes', { maxBytes: 1 }, frozenClock],
    ['time', { maxDurationMs: 1 }, (() => { let tick = 0; return () => tick++; })()],
  ] as const)('makes the %s traversal limit visible', (reason, override, clock) => {
    const input = fixture();
    const limited: ChangeImpactInput = {
      ...input,
      configuration: {
        ...input.configuration,
        traversal: { ...input.configuration.traversal, ...override },
      },
    };
    const result = deriveChangeImpact(limited, { monotonicNow: clock });
    const downstream = result.impactMap.cones.find(
      (cone) => cone.targetId === 'target-api' && cone.kind === 'downstream',
    );
    expect(downstream?.partial).toBe(true);
    expect(downstream?.truncationReasons).toContain(reason);
    expect(result.impactMap.uncertainty).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'truncated', nodeId: 'target-api' }),
    ]));
  });

  it('keeps file-only analysis functional with explicit unavailable coverage', () => {
    const input = fixture();
    const { baseSnapshot: _baseSnapshot, headSnapshot: _headSnapshot, ...withoutSnapshots } = input;
    const fileOnly: ChangeImpactInput = {
      ...withoutSnapshots,
      configuration: { ...input.configuration, mode: 'file-only' },
    };
    const result = deriveChangeImpact(fileOnly, { monotonicNow: frozenClock });

    expect(result.impactMap.coverage).toBe('unavailable');
    expect(result.impactMap.graphDelta.nodes).toEqual([]);
    expect(result.impactMap.neighborhoods).toHaveLength(3);
    expect(result.impactMap.cones.every((cone) => cone.coverage === 'unavailable')).toBe(true);
    expect(result.contextPlan.questions[0]?.items.map((item) => item.id)).toEqual(['diff', 'witness', 'requirements']);
  });

  it('rejects graph-selected context without provider and query provenance', () => {
    const input = fixture();
    const invalid: ChangeImpactInput = {
      ...input,
      contextCandidates: input.contextCandidates.map((candidate) => {
        if (candidate.id !== 'witness') return candidate;
        const { provenance: _provenance, ...withoutProvenance } = candidate;
        return withoutProvenance;
      }),
    };
    expect(() => deriveChangeImpact(invalid, { monotonicNow: frozenClock })).toThrow(
      'graph context candidate witness requires provider/query provenance',
    );
  });

  it('distinguishes missing tests from unknown test coverage', () => {
    const input = fixture();
    const head = input.headSnapshot;
    if (head === undefined) throw new Error('fixture head snapshot is required');
    const withoutTests = snapshot(
      'head',
      head.nodes.filter((value) => value.id !== 'test'),
      head.edges.filter((value) => value.id !== 'tests-api'),
    );
    const complete = deriveChangeImpact({ ...input, headSnapshot: withoutTests }, { monotonicNow: frozenClock });
    const { baseSnapshot: _baseSnapshot, headSnapshot: _headSnapshot, ...noIndexInput } = input;
    const fileOnly = deriveChangeImpact(noIndexInput, { monotonicNow: frozenClock });

    expect(complete.impactMap.testReachability.find((item) => item.targetId === 'target-api')?.status).toBe('not-discovered');
    expect(fileOnly.impactMap.testReachability.find((item) => item.targetId === 'target-api')?.status).toBe('unknown');
  });
});
