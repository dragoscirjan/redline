import { performance } from 'node:perf_hooks';
import { parseCodeIntelligenceSnapshot } from '../code-intelligence/contracts.js';
import {
  CHANGE_IMPACT_MAP_VERSION,
  CONTEXT_PLAN_VERSION,
  GRAPH_DELTA_VERSION,
  type ChangeImpactInput,
  type ChangeImpactMap,
  type ChangeImpactResult,
  type ChangeNeighborhood,
  type ChangedTarget,
  type CodeIntelligenceSnapshot,
  type ContextCandidate,
  type ContextCategory,
  type ContractSurfaceDelta,
  type CoverageStatus,
  type EdgeDelta,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphNodeRole,
  type ImpactCone,
  type ImpactConeKind,
  type ImpactUncertainty,
  type NodeDelta,
  type PathWitness,
  type QuestionContextPlan,
  type ReviewContextPlan,
  type ReviewQuestion,
  type RiskProfile,
  type SelectedContextItem,
  type SpecialistDimension,
  type StateEffectIndicator,
  type TestReachability,
  type TraversalBudget,
  type TruncationReason,
} from './types.js';

const CONTEXT_CATEGORY_ORDER: Readonly<Record<ContextCategory, number>> = {
  'diff-declaration': 0,
  'base-head-span': 1,
  'path-witness': 2,
  'direct-relation-contract': 3,
  'test-fixture': 4,
  'state-effect-schema-config': 5,
  'requirements-guidance': 6,
  'secondary-graph': 7,
};

const GRAPH_CONTEXT_CATEGORIES = new Set<ContextCategory>([
  'path-witness',
  'direct-relation-contract',
  'test-fixture',
  'state-effect-schema-config',
  'secondary-graph',
]);

const STATE_EFFECT_ROLES = new Set([
  'state-read',
  'state-write',
  'event',
  'external-call',
  'resource-owner',
  'persistent-state',
] as const);

const IMPLEMENTATION_RELATION = /implement|extend|inherit|override|interface/iu;
const TEST_RELATION = /test|cover|fixture|assert|spec/iu;
const CONTRACT_RELATION = /api|schema|contract|event|command|config|implement|interface/iu;

interface PlannerOptions {
  readonly monotonicNow?: () => number;
}

interface GraphView {
  readonly snapshot: CodeIntelligenceSnapshot;
  readonly side: 'base' | 'head';
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly incoming: ReadonlyMap<string, readonly GraphEdge[]>;
}

interface QueueItem {
  readonly nodeId: string;
  readonly depth: number;
  readonly nodePath: readonly string[];
  readonly edgePath: readonly string[];
  readonly approximate: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
}

function assertUniqueIds(values: readonly { readonly id: string }[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    assertNonEmpty(value.id, `${label} id`);
    if (seen.has(value.id)) throw new Error(`${label} id is duplicated: ${value.id}`);
    seen.add(value.id);
  }
}

function validateBudget(budget: TraversalBudget): void {
  assertPositiveInteger(budget.maxDepth, 'traversal.maxDepth');
  assertPositiveInteger(budget.maxFanOut, 'traversal.maxFanOut');
  assertPositiveInteger(budget.maxNodes, 'traversal.maxNodes');
  assertPositiveInteger(budget.maxEdges, 'traversal.maxEdges');
  assertPositiveInteger(budget.maxBytes, 'traversal.maxBytes');
  assertPositiveInteger(budget.maxDurationMs, 'traversal.maxDurationMs');
  assertPositiveInteger(budget.maxWitnesses, 'traversal.maxWitnesses');
}

function validateSnapshot(snapshot: CodeIntelligenceSnapshot, expectedRevision: string, label: string): void {
  parseCodeIntelligenceSnapshot(snapshot);
  if (snapshot.revision !== expectedRevision) {
    throw new Error(`${label}.revision does not match the requested immutable revision`);
  }
}

function validateInput(input: ChangeImpactInput): void {
  assertNonEmpty(input.baseRevision, 'baseRevision');
  assertNonEmpty(input.headRevision, 'headRevision');
  if (input.baseRevision === input.headRevision) throw new Error('baseRevision and headRevision must differ');
  validateBudget(input.configuration.traversal);
  assertUniqueIds(input.changedTargets, 'changed target');
  assertUniqueIds(input.contextCandidates, 'context candidate');
  assertUniqueIds(input.questions, 'review question');
  if (input.baseSnapshot !== undefined) validateSnapshot(input.baseSnapshot, input.baseRevision, 'baseSnapshot');
  if (input.headSnapshot !== undefined) validateSnapshot(input.headSnapshot, input.headRevision, 'headSnapshot');
  if (
    input.baseSnapshot !== undefined &&
    input.headSnapshot !== undefined &&
    input.baseSnapshot.id === input.headSnapshot.id
  ) throw new Error('baseSnapshot and headSnapshot must have distinct immutable identities');
  for (const target of input.changedTargets) {
    if (target.oldPath === null && target.newPath === null) {
      throw new Error(`changed target ${target.id} must have an old or new path`);
    }
  }
  for (const candidate of input.contextCandidates) {
    assertNonEmpty(candidate.path, `context candidate ${candidate.id}.path`);
    assertNonEmpty(candidate.digest, `context candidate ${candidate.id}.digest`);
    assertNonEmpty(candidate.selectionReason, `context candidate ${candidate.id}.selectionReason`);
    if (GRAPH_CONTEXT_CATEGORIES.has(candidate.category) && candidate.provenance === undefined) {
      throw new Error(`graph context candidate ${candidate.id} requires provider/query provenance`);
    }
  }
  const targetIds = new Set(input.changedTargets.map((target) => target.id));
  for (const question of input.questions) {
    assertPositiveInteger(question.byteBudget, `review question ${question.id}.byteBudget`);
    assertPositiveInteger(question.tokenBudget, `review question ${question.id}.tokenBudget`);
    for (const targetId of question.targetIds) {
      if (!targetIds.has(targetId)) throw new Error(`review question ${question.id} references unknown target ${targetId}`);
    }
  }
}

function mapById<T extends { readonly id: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function comparableSpan(node: GraphNode): string {
  return node.span === undefined ? '' : `${node.span.startLine}:${node.span.endLine}`;
}

function changedNodeFields(base: GraphNode, head: GraphNode): string[] {
  const changed: string[] = [];
  if (base.kind !== head.kind) changed.push('kind');
  if (base.name !== head.name) changed.push('name');
  if (base.path !== head.path) changed.push('path');
  if (comparableSpan(base) !== comparableSpan(head)) changed.push('span');
  if (base.digest !== head.digest) changed.push('digest');
  if (base.signature !== head.signature) changed.push('signature');
  if (base.public !== head.public) changed.push('public');
  if (sortedUnique(base.roles).join('\0') !== sortedUnique(head.roles).join('\0')) changed.push('roles');
  if (base.ambiguous !== head.ambiguous) changed.push('ambiguous');
  return changed;
}

function changedEdgeFields(base: GraphEdge, head: GraphEdge): string[] {
  const changed: string[] = [];
  if (base.kind !== head.kind) changed.push('kind');
  if (base.from !== head.from) changed.push('from');
  if (base.to !== head.to) changed.push('to');
  if (base.digest !== head.digest) changed.push('digest');
  if (base.approximate !== head.approximate) changed.push('approximate');
  return changed;
}

function compareSnapshots(
  baseSnapshot: CodeIntelligenceSnapshot | undefined,
  headSnapshot: CodeIntelligenceSnapshot | undefined,
  targets: readonly ChangedTarget[],
): GraphDelta {
  const baseNodes = mapById(baseSnapshot?.nodes ?? []);
  const headNodes = mapById(headSnapshot?.nodes ?? []);
  const nodeIds = sortedUnique([...baseNodes.keys(), ...headNodes.keys()]);
  const nodes: NodeDelta[] = [];
  for (const id of nodeIds) {
    const base = baseNodes.get(id);
    const head = headNodes.get(id);
    if (base === undefined && head !== undefined) {
      nodes.push({ id, kind: 'added', head, changedFields: [] });
    } else if (base !== undefined && head === undefined) {
      nodes.push({ id, kind: 'removed', base, changedFields: [] });
    } else if (base !== undefined && head !== undefined) {
      const changedFields = changedNodeFields(base, head);
      if (changedFields.length > 0) {
        const renamed = changedFields.includes('name') || changedFields.includes('path');
        nodes.push({ id, kind: renamed ? 'renamed' : 'changed', base, head, changedFields });
      }
    }
  }

  const baseEdges = mapById(baseSnapshot?.edges ?? []);
  const headEdges = mapById(headSnapshot?.edges ?? []);
  const edgeIds = sortedUnique([...baseEdges.keys(), ...headEdges.keys()]);
  const edges: EdgeDelta[] = [];
  for (const id of edgeIds) {
    const base = baseEdges.get(id);
    const head = headEdges.get(id);
    if (base === undefined && head !== undefined) {
      edges.push({ id, kind: 'added', head, changedFields: [] });
    } else if (base !== undefined && head === undefined) {
      edges.push({ id, kind: 'removed', base, changedFields: [] });
    } else if (base !== undefined && head !== undefined) {
      const changedFields = changedEdgeFields(base, head);
      if (changedFields.length > 0) edges.push({ id, kind: 'changed', base, head, changedFields });
    }
  }

  const unresolved = new Set<string>();
  for (const target of targets) {
    if (target.baseNodeId !== undefined && !baseNodes.has(target.baseNodeId)) unresolved.add(target.id);
    if (target.headNodeId !== undefined && !headNodes.has(target.headNodeId)) unresolved.add(target.id);
    if (target.status === 'A' && target.headNodeId === undefined) unresolved.add(target.id);
    if (target.status === 'D' && target.baseNodeId === undefined) unresolved.add(target.id);
  }
  for (const node of [...(baseSnapshot?.nodes ?? []), ...(headSnapshot?.nodes ?? [])]) {
    if (node.ambiguous === true) unresolved.add(node.id);
  }

  const baseCapabilities = new Set(baseSnapshot?.capabilities ?? []);
  const headCapabilities = new Set(headSnapshot?.capabilities ?? []);
  return {
    version: GRAPH_DELTA_VERSION,
    baseRevision: baseSnapshot?.revision ?? null,
    headRevision: headSnapshot?.revision ?? null,
    nodes,
    edges,
    unresolvedIdentity: sortedUnique(unresolved),
    capabilities: {
      added: sortedUnique([...headCapabilities].filter((value) => !baseCapabilities.has(value))),
      removed: sortedUnique([...baseCapabilities].filter((value) => !headCapabilities.has(value))),
      baseCoverage: baseSnapshot?.coverage ?? 'unavailable',
      headCoverage: headSnapshot?.coverage ?? 'unavailable',
    },
  };
}

function buildGraphView(snapshot: CodeIntelligenceSnapshot, side: 'base' | 'head'): GraphView {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const node of snapshot.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of snapshot.edges) {
    outgoing.get(edge.from)?.push(edge);
    incoming.get(edge.to)?.push(edge);
  }
  for (const edges of [...outgoing.values(), ...incoming.values()]) edges.sort((a, b) => compareText(a.id, b.id));
  return { snapshot, side, nodes: mapById(snapshot.nodes), outgoing, incoming };
}

function targetNodeIds(target: ChangedTarget): string[] {
  return sortedUnique([target.baseNodeId, target.headNodeId].filter((value): value is string => value !== undefined));
}

function buildNeighborhoods(
  targets: readonly ChangedTarget[],
  baseSnapshot: CodeIntelligenceSnapshot | undefined,
  headSnapshot: CodeIntelligenceSnapshot | undefined,
): ChangeNeighborhood[] {
  const sortedTargets = [...targets].sort((a, b) => compareText(a.id, b.id));
  const targetByNode = new Map<string, string[]>();
  for (const target of sortedTargets) {
    for (const nodeId of targetNodeIds(target)) {
      const related = targetByNode.get(nodeId) ?? [];
      related.push(target.id);
      targetByNode.set(nodeId, related);
    }
  }
  const adjacency = new Map(sortedTargets.map((target) => [target.id, new Set<string>()]));
  const relationEdges = new Map<string, Set<string>>();
  for (const edge of [...(baseSnapshot?.edges ?? []), ...(headSnapshot?.edges ?? [])].sort((a, b) => compareText(a.id, b.id))) {
    const fromTargets = targetByNode.get(edge.from) ?? [];
    const toTargets = targetByNode.get(edge.to) ?? [];
    for (const left of fromTargets) {
      for (const right of toTargets) {
        if (left === right) continue;
        adjacency.get(left)?.add(right);
        adjacency.get(right)?.add(left);
        const key = [left, right].sort(compareText).join('\0');
        const ids = relationEdges.get(key) ?? new Set<string>();
        ids.add(edge.id);
        relationEdges.set(key, ids);
      }
    }
  }

  const targetById = mapById(sortedTargets);
  const visited = new Set<string>();
  const neighborhoods: ChangeNeighborhood[] = [];
  for (const target of sortedTargets) {
    if (visited.has(target.id)) continue;
    const queue = [target.id];
    const component: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      const next = [...(adjacency.get(current) ?? [])].sort(compareText);
      queue.push(...next.filter((value) => !visited.has(value)));
    }
    component.sort(compareText);
    const componentSet = new Set(component);
    const edgeIds = new Set<string>();
    for (const [key, ids] of relationEdges) {
      const [left, right] = key.split('\0');
      if (left !== undefined && right !== undefined && componentSet.has(left) && componentSet.has(right)) {
        for (const id of ids) edgeIds.add(id);
      }
    }
    const paths = component.flatMap((id) => {
      const item = targetById.get(id);
      return item === undefined ? [] : [item.oldPath, item.newPath].filter((path): path is string => path !== null);
    });
    const partial = component.some((id) => {
      const item = targetById.get(id);
      return item === undefined || targetNodeIds(item).length === 0;
    });
    neighborhoods.push({
      id: `neighborhood-${String(neighborhoods.length + 1).padStart(3, '0')}`,
      targetIds: component,
      paths: sortedUnique(paths),
      relationEdgeIds: sortedUnique(edgeIds),
      partial,
    });
  }
  return neighborhoods;
}

function edgeAllowed(kind: ImpactConeKind, edge: GraphEdge): boolean {
  if (kind === 'implementation') return IMPLEMENTATION_RELATION.test(edge.kind);
  if (kind === 'test') return TEST_RELATION.test(edge.kind);
  if (kind === 'contract') return CONTRACT_RELATION.test(edge.kind);
  return true;
}

function adjacentEdges(view: GraphView, nodeId: string, kind: ImpactConeKind): readonly GraphEdge[] {
  if (kind === 'upstream') return view.incoming.get(nodeId) ?? [];
  if (kind === 'downstream') return view.outgoing.get(nodeId) ?? [];
  return [...(view.outgoing.get(nodeId) ?? []), ...(view.incoming.get(nodeId) ?? [])]
    .filter((edge) => edgeAllowed(kind, edge))
    .sort((a, b) => compareText(a.id, b.id));
}

function nextNodeId(view: GraphView, current: string, edge: GraphEdge, kind: ImpactConeKind): string {
  if (kind === 'upstream') return edge.from;
  if (kind === 'downstream') return edge.to;
  return edge.from === current ? edge.to : edge.from;
}

function isWitnessDestination(kind: ImpactConeKind, node: GraphNode): boolean {
  if (kind === 'upstream') return node.roles.includes('entry-point') || node.roles.includes('test');
  if (kind === 'downstream') {
    return node.roles.some((role) => STATE_EFFECT_ROLES.has(role as never) || role === 'configuration');
  }
  if (kind === 'implementation') return true;
  if (kind === 'test') return node.roles.includes('test') || node.roles.includes('fixture');
  return node.roles.includes('contract') || node.roles.includes('configuration') || node.public === true;
}

function serializedBytes(value: GraphNode | GraphEdge): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function deriveCone(
  target: ChangedTarget,
  kind: ImpactConeKind,
  view: GraphView | undefined,
  triggerNodeId: string | undefined,
  budget: TraversalBudget,
  now: () => number,
): ImpactCone {
  const id = `${target.id}:${view?.side ?? 'head'}:${kind}`;
  if (view === undefined || triggerNodeId === undefined || !view.nodes.has(triggerNodeId)) {
    return {
      id,
      targetId: target.id,
      kind,
      revision: view?.side ?? 'head',
      nodeIds: [],
      edgeIds: [],
      witnesses: [],
      coverage: 'unavailable',
      partial: true,
      truncationReasons: [],
    };
  }

  const startedAt = now();
  const visitedNodes = new Set<string>([triggerNodeId]);
  const selectedNodes = new Set<string>();
  const selectedEdges = new Set<string>();
  const witnesses: PathWitness[] = [];
  const truncation = new Set<TruncationReason>();
  let bytes = 0;
  const queue: QueueItem[] = [{
    nodeId: triggerNodeId,
    depth: 0,
    nodePath: [triggerNodeId],
    edgePath: [],
    approximate: false,
  }];

  while (queue.length > 0) {
    if (now() - startedAt >= budget.maxDurationMs) {
      truncation.add('time');
      break;
    }
    const current = queue.shift();
    if (current === undefined) break;
    const availableEdges = adjacentEdges(view, current.nodeId, kind).filter((edge) => !selectedEdges.has(edge.id));
    if (current.depth >= budget.maxDepth) {
      if (availableEdges.length > 0) truncation.add('depth');
      continue;
    }
    if (availableEdges.length > budget.maxFanOut) truncation.add('fan-out');
    const boundedEdges = availableEdges.slice(0, budget.maxFanOut);
    for (const edge of boundedEdges) {
      if (selectedEdges.size >= budget.maxEdges) {
        truncation.add('edges');
        break;
      }
      const nextId = nextNodeId(view, current.nodeId, edge, kind);
      const node = view.nodes.get(nextId);
      if (node === undefined) continue;
      const additionalBytes = serializedBytes(edge) + (visitedNodes.has(nextId) ? 0 : serializedBytes(node));
      if (bytes + additionalBytes > budget.maxBytes) {
        truncation.add('bytes');
        continue;
      }
      if (!visitedNodes.has(nextId) && selectedNodes.size >= budget.maxNodes) {
        truncation.add('nodes');
        continue;
      }
      selectedEdges.add(edge.id);
      bytes += serializedBytes(edge);
      if (visitedNodes.has(nextId)) continue;
      visitedNodes.add(nextId);
      selectedNodes.add(nextId);
      bytes += serializedBytes(node);
      const nodePath = [...current.nodePath, nextId];
      const edgePath = [...current.edgePath, edge.id];
      const approximate = current.approximate || edge.approximate === true;
      if (witnesses.length < budget.maxWitnesses && isWitnessDestination(kind, node)) {
        witnesses.push({
          id: `${id}:witness-${String(witnesses.length + 1).padStart(3, '0')}`,
          cone: kind,
          revision: view.side,
          triggerNodeId,
          nodeIds: nodePath,
          edgeIds: edgePath,
          reason: `Shortest bounded ${kind} path selected for ${target.id}`,
          approximate,
        });
      }
      queue.push({ nodeId: nextId, depth: current.depth + 1, nodePath, edgePath, approximate });
    }
  }

  const partial = truncation.size > 0 || view.snapshot.coverage !== 'complete';
  const coverage: CoverageStatus = view.snapshot.coverage === 'complete' && !partial ? 'complete' :
    view.snapshot.coverage === 'unsupported' ? 'unsupported' : 'partial';
  return {
    id,
    targetId: target.id,
    kind,
    revision: view.side,
    nodeIds: sortedUnique(selectedNodes),
    edgeIds: sortedUnique(selectedEdges),
    witnesses,
    coverage,
    partial,
    truncationReasons: [...truncation].sort(compareText),
  };
}

function preferredView(
  target: ChangedTarget,
  base: GraphView | undefined,
  head: GraphView | undefined,
): { readonly view: GraphView | undefined; readonly nodeId: string | undefined } {
  if (target.headNodeId !== undefined && head?.nodes.has(target.headNodeId) === true) {
    return { view: head, nodeId: target.headNodeId };
  }
  if (target.baseNodeId !== undefined && base?.nodes.has(target.baseNodeId) === true) {
    return { view: base, nodeId: target.baseNodeId };
  }
  return { view: head ?? base, nodeId: target.headNodeId ?? target.baseNodeId };
}

function deriveCones(
  targets: readonly ChangedTarget[],
  baseSnapshot: CodeIntelligenceSnapshot | undefined,
  headSnapshot: CodeIntelligenceSnapshot | undefined,
  budget: TraversalBudget,
  now: () => number,
): ImpactCone[] {
  const base = baseSnapshot === undefined ? undefined : buildGraphView(baseSnapshot, 'base');
  const head = headSnapshot === undefined ? undefined : buildGraphView(headSnapshot, 'head');
  const kinds: readonly ImpactConeKind[] = ['upstream', 'downstream', 'implementation', 'test', 'contract'];
  return [...targets]
    .sort((a, b) => compareText(a.id, b.id))
    .flatMap((target) => {
      const selected = preferredView(target, base, head);
      return kinds.map((kind) => deriveCone(target, kind, selected.view, selected.nodeId, budget, now));
    });
}

function allNodeMap(...snapshots: readonly (CodeIntelligenceSnapshot | undefined)[]): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const snapshot of snapshots) {
    for (const node of snapshot?.nodes ?? []) nodes.set(node.id, node);
  }
  return nodes;
}

function isStateEffectRole(role: GraphNodeRole): role is StateEffectIndicator['role'] {
  return STATE_EFFECT_ROLES.has(role as StateEffectIndicator['role']);
}

function deriveStateEffects(
  targets: readonly ChangedTarget[],
  cones: readonly ImpactCone[],
  nodes: ReadonlyMap<string, GraphNode>,
): StateEffectIndicator[] {
  const result: StateEffectIndicator[] = [];
  const seen = new Set<string>();
  const approximateNodes = new Set(
    cones.flatMap((cone) => cone.witnesses.filter((witness) => witness.approximate).flatMap((witness) => witness.nodeIds)),
  );
  const nodeIdsByTarget = new Map<string, Set<string>>();
  for (const target of targets) nodeIdsByTarget.set(target.id, new Set(targetNodeIds(target)));
  for (const cone of cones) {
    const selected = nodeIdsByTarget.get(cone.targetId) ?? new Set<string>();
    for (const nodeId of cone.nodeIds) selected.add(nodeId);
    nodeIdsByTarget.set(cone.targetId, selected);
  }
  for (const [targetId, nodeIds] of [...nodeIdsByTarget].sort(([left], [right]) => compareText(left, right))) {
    for (const nodeId of [...nodeIds].sort(compareText)) {
      const node = nodes.get(nodeId);
      if (node === undefined) continue;
      for (const role of node.roles) {
        if (!isStateEffectRole(role)) continue;
        const key = `${targetId}\0${nodeId}\0${role}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          targetId,
          nodeId,
          role,
          certainty: node.ambiguous === true
            ? 'unknown'
            : approximateNodes.has(nodeId) || node.provenance.status !== 'complete'
              ? 'approximate'
              : 'exact',
        });
      }
    }
  }
  return result.sort((a, b) => compareText(`${a.targetId}\0${a.nodeId}\0${a.role}`, `${b.targetId}\0${b.nodeId}\0${b.role}`));
}

function deriveTestReachability(
  targets: readonly ChangedTarget[],
  cones: readonly ImpactCone[],
  nodes: ReadonlyMap<string, GraphNode>,
): TestReachability[] {
  return [...targets].sort((a, b) => compareText(a.id, b.id)).map((target) => {
    const cone = cones.find((candidate) => candidate.targetId === target.id && candidate.kind === 'test');
    const testNodeIds = sortedUnique((cone?.nodeIds ?? []).filter((id) => nodes.get(id)?.roles.includes('test') === true));
    const fixtureNodeIds = sortedUnique((cone?.nodeIds ?? []).filter((id) => nodes.get(id)?.roles.includes('fixture') === true));
    const status = testNodeIds.length > 0 ? 'discovered' : cone?.coverage === 'complete' ? 'not-discovered' : 'unknown';
    const indirect = (cone?.witnesses ?? []).some((witness) => witness.nodeIds.length > 2);
    return { targetId: target.id, testNodeIds, fixtureNodeIds, status, indirect };
  });
}

function isContractNode(node: GraphNode | undefined): boolean {
  return node !== undefined && (node.public === true || node.roles.includes('contract') || node.roles.includes('configuration'));
}

function deriveContractSurface(delta: GraphDelta): ContractSurfaceDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const item of delta.nodes) {
    if (item.kind === 'added' && isContractNode(item.head)) added.push(item.id);
    if (item.kind === 'removed' && isContractNode(item.base)) removed.push(item.id);
    if ((item.kind === 'changed' || item.kind === 'renamed') && (isContractNode(item.base) || isContractNode(item.head))) {
      changed.push(item.id);
    }
  }
  return { addedNodeIds: sortedUnique(added), removedNodeIds: sortedUnique(removed), changedNodeIds: sortedUnique(changed) };
}

function uncertaintyCode(code: string): ImpactUncertainty['code'] {
  if (/dynamic|reflection|dispatch|generation|injection/iu.test(code)) return 'dynamic-behavior';
  if (/disagree/iu.test(code)) return 'provider-disagreement';
  if (/fail|error/iu.test(code)) return 'failed-query';
  if (/unsupported/iu.test(code)) return 'unsupported';
  if (/source/iu.test(code)) return 'unresolved-source';
  return 'missing-capability';
}

function deriveUncertainty(
  input: ChangeImpactInput,
  delta: GraphDelta,
  cones: readonly ImpactCone[],
): ImpactUncertainty[] {
  const result: ImpactUncertainty[] = [];
  const push = (item: Omit<ImpactUncertainty, 'id'>): void => {
    result.push({ id: `uncertainty-${String(result.length + 1).padStart(3, '0')}`, ...item });
  };
  if (input.baseSnapshot === undefined) {
    push({ code: 'unavailable', message: 'Base code-intelligence snapshot is unavailable.', coverage: 'unavailable' });
  }
  if (input.headSnapshot === undefined) {
    push({ code: 'unavailable', message: 'Head code-intelligence snapshot is unavailable.', coverage: 'unavailable' });
  }
  for (const value of delta.unresolvedIdentity) {
    push({ code: 'ambiguous-identity', message: `Identity could not be resolved for ${value}.`, coverage: 'partial', nodeId: value });
  }
  for (const cone of cones) {
    if (cone.truncationReasons.length > 0) {
      push({
        code: 'truncated',
        message: `${cone.id} was truncated by ${cone.truncationReasons.join(', ')} budget.`,
        coverage: 'partial',
        nodeId: cone.targetId,
      });
    }
  }
  for (const snapshot of [input.baseSnapshot, input.headSnapshot]) {
    for (const item of snapshot?.uncertainty ?? []) {
      const code = uncertaintyCode(item.code);
      const base = {
        code,
        message: item.message,
        coverage: code === 'unsupported' ? 'unsupported' as const : 'partial' as const,
      };
      push({
        ...base,
        ...(item.path === undefined ? {} : { path: item.path }),
        ...(item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
        ...(item.queryId === undefined ? {} : { queryId: item.queryId }),
      });
    }
  }
  return result;
}

function aggregateCoverage(
  baseSnapshot: CodeIntelligenceSnapshot | undefined,
  headSnapshot: CodeIntelligenceSnapshot | undefined,
  uncertainty: readonly ImpactUncertainty[],
): CoverageStatus {
  if (baseSnapshot === undefined || headSnapshot === undefined) return 'unavailable';
  if (baseSnapshot.coverage === 'unsupported' || headSnapshot.coverage === 'unsupported') return 'unsupported';
  if (
    baseSnapshot.coverage !== 'complete' ||
    headSnapshot.coverage !== 'complete' ||
    uncertainty.some((item) => item.coverage !== 'complete')
  ) return 'partial';
  return 'complete';
}

function deriveRisk(
  cones: readonly ImpactCone[],
  stateEffects: readonly StateEffectIndicator[],
  tests: readonly TestReachability[],
  contractSurface: ContractSurfaceDelta,
): RiskProfile {
  const relatedNodes = new Set(cones.flatMap((cone) => cone.nodeIds));
  const relatedEdges = new Set(cones.flatMap((cone) => cone.edgeIds));
  const reasons: string[] = [];
  let blastRadius: RiskProfile['blastRadius'] = 'small';
  if (relatedNodes.size === 0 && relatedEdges.size === 0) blastRadius = 'unknown';
  else if (relatedNodes.size > 20 || relatedEdges.size > 30) blastRadius = 'large';
  else if (relatedNodes.size > 6 || relatedEdges.size > 10) blastRadius = 'medium';
  reasons.push(`${relatedNodes.size} related nodes and ${relatedEdges.size} related edges were selected.`);

  const dimensions = new Set<SpecialistDimension>();
  if (stateEffects.some((item) => item.role === 'state-write' || item.role === 'persistent-state')) {
    dimensions.add('data-integrity-concurrency');
  }
  if (stateEffects.some((item) => item.role === 'external-call' || item.role === 'resource-owner')) {
    dimensions.add('reliability-recovery');
    dimensions.add('performance-resource-use');
  }
  if (stateEffects.some((item) => item.role === 'event')) dimensions.add('observability');
  if (tests.some((item) => item.status !== 'discovered')) dimensions.add('test-quality');
  const changedContracts =
    contractSurface.addedNodeIds.length + contractSurface.removedNodeIds.length + contractSurface.changedNodeIds.length;
  if (changedContracts > 0) {
    dimensions.add('compatibility');
    reasons.push(`${changedContracts} public contract nodes changed.`);
  }
  if (relatedNodes.size > 0) dimensions.add('design-maintainability');

  let reversibility: RiskProfile['reversibility'] = 'easy';
  if (stateEffects.some((item) => item.role === 'persistent-state' || item.role === 'external-call')) reversibility = 'hard';
  else if (stateEffects.length > 0 || changedContracts > 0) reversibility = 'moderate';
  if (relatedNodes.size === 0) reversibility = 'unknown';
  return {
    blastRadius,
    reversibility,
    specialistDimensions: [...dimensions].sort(compareText),
    reasons,
  };
}

function candidateMatchesQuestion(candidate: ContextCandidate, question: ReviewQuestion): boolean {
  if (candidate.targetIds.length === 0) return true;
  const requested = new Set(question.targetIds);
  return candidate.targetIds.some((targetId) => requested.has(targetId));
}

function compareCandidates(left: ContextCandidate, right: ContextCandidate): number {
  return CONTEXT_CATEGORY_ORDER[left.category] - CONTEXT_CATEGORY_ORDER[right.category]
    || compareText(left.path, right.path)
    || (left.span?.startLine ?? 0) - (right.span?.startLine ?? 0)
    || compareText(left.id, right.id);
}

function selectQuestionContext(
  question: ReviewQuestion,
  candidates: readonly ContextCandidate[],
  impactCoverage: CoverageStatus,
): QuestionContextPlan {
  const selected: SelectedContextItem[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  let tokens = 0;
  for (const candidate of candidates.filter((value) => candidateMatchesQuestion(value, question)).sort(compareCandidates)) {
    const candidateBytes = Buffer.byteLength(candidate.content, 'utf8');
    const candidateTokens = Math.ceil(candidateBytes / 4);
    if (bytes + candidateBytes > question.byteBudget || tokens + candidateTokens > question.tokenBudget) {
      omitted.push(candidate.id);
      continue;
    }
    selected.push({ ...candidate, bytes: candidateBytes, tokenEstimate: candidateTokens });
    bytes += candidateBytes;
    tokens += candidateTokens;
  }
  const coverage = omitted.length > 0 && impactCoverage === 'complete' ? 'partial' : impactCoverage;
  return {
    questionId: question.id,
    specialist: question.specialist,
    items: selected,
    omittedCandidateIds: omitted,
    bytes,
    tokenEstimate: tokens,
    coverage,
  };
}

function buildContextPlan(
  questions: readonly ReviewQuestion[],
  candidates: readonly ContextCandidate[],
  impactCoverage: CoverageStatus,
): ReviewContextPlan {
  return {
    version: CONTEXT_PLAN_VERSION,
    accounting: 'utf8-bytes-and-ceil-bytes-div-4',
    questions: [...questions]
      .sort((a, b) => compareText(a.id, b.id))
      .map((question) => selectQuestionContext(question, candidates, impactCoverage)),
  };
}

/**
 * Produces a normalized impact map and question-specific context plan.
 * Provider-native impact output may be normalized into the input snapshots,
 * but it never replaces these contracts or source validation.
 */
export function deriveChangeImpact(
  input: ChangeImpactInput,
  options: PlannerOptions = {},
): ChangeImpactResult {
  validateInput(input);
  const now = options.monotonicNow ?? (() => performance.now());
  const graphDelta = compareSnapshots(input.baseSnapshot, input.headSnapshot, input.changedTargets);
  const neighborhoods = buildNeighborhoods(input.changedTargets, input.baseSnapshot, input.headSnapshot);
  const cones = deriveCones(
    input.changedTargets,
    input.baseSnapshot,
    input.headSnapshot,
    input.configuration.traversal,
    now,
  );
  const nodes = allNodeMap(input.baseSnapshot, input.headSnapshot);
  const stateEffects = deriveStateEffects(input.changedTargets, cones, nodes);
  const testReachability = deriveTestReachability(input.changedTargets, cones, nodes);
  const contractSurface = deriveContractSurface(graphDelta);
  const uncertainty = deriveUncertainty(input, graphDelta, cones);
  const coverage = aggregateCoverage(input.baseSnapshot, input.headSnapshot, uncertainty);
  const risk = deriveRisk(cones, stateEffects, testReachability, contractSurface);
  const impactMap: ChangeImpactMap = {
    version: CHANGE_IMPACT_MAP_VERSION,
    mode: input.configuration.mode,
    baseRevision: input.baseRevision,
    headRevision: input.headRevision,
    intent: input.intent ?? { acceptanceCriteria: [] },
    changedTargets: [...input.changedTargets].sort((a, b) => compareText(a.id, b.id)),
    graphDelta,
    neighborhoods,
    cones,
    witnesses: cones.flatMap((cone) => cone.witnesses),
    stateEffects,
    testReachability,
    contractSurface,
    uncertainty,
    risk,
    coverage,
  };
  return {
    impactMap,
    contextPlan: buildContextPlan(input.questions, input.contextCandidates, coverage),
  };
}
