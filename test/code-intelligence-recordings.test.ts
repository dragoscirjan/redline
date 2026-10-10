import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  assertQueryResultMatches,
  parseCodeIntelligenceQuery,
  parseCodeIntelligenceRecording,
} from '../src/code-intelligence/contracts.js';
import { CodeIntelligenceProviderRegistry } from '../src/code-intelligence/registry.js';
import type {
  CodeIntelligenceQuery,
  CodeIntelligenceRecording,
  CodeIntelligenceSnapshot,
} from '../src/code-intelligence/types.js';
import { RecordedCodeIntelligenceProvider } from './helpers/code-intelligence-conformance.js';

async function load(name: 'gitnexus' | 'cgc'): Promise<CodeIntelligenceRecording> {
  const text = await readFile(new URL(`./fixtures/code-intelligence/${name}.json`, import.meta.url), 'utf8');
  return parseCodeIntelligenceRecording(JSON.parse(text));
}

function buildRequest(recording: CodeIntelligenceRecording) {
  return {
    repositoryId: recording.snapshot.repositoryId,
    sourceDirectory: '/captured/source',
    revision: recording.snapshot.revision,
    sourceTreeDigest: recording.snapshot.sourceTreeDigest,
    configurationDigest: recording.snapshot.configurationDigest,
    workDirectory: '/trusted/work',
    timeoutMs: 1_000,
  };
}

function callersQuery(recording: CodeIntelligenceRecording): CodeIntelligenceQuery {
  return parseCodeIntelligenceQuery({
    version: 1,
    id: 'query:callers',
    snapshotId: recording.snapshot.id,
    revision: recording.snapshot.revision,
    capability: 'callers-callees',
    target: { kind: 'node', nodeId: 'service' },
    retrievalReason: 'Find callers of service',
    budget: {
      maxDepth: 2,
      maxFanOut: 10,
      maxResults: 10,
      maxBytes: 4_096,
      maxDurationMs: 1_000,
    },
  });
}

function commonQueries(recording: CodeIntelligenceRecording): readonly CodeIntelligenceQuery[] {
  const common = {
    version: 1,
    snapshotId: recording.snapshot.id,
    revision: recording.snapshot.revision,
    budget: {
      maxDepth: 2,
      maxFanOut: 10,
      maxResults: 10,
      maxBytes: 4_096,
      maxDurationMs: 1_000,
    },
  } as const;
  return [
    callersQuery(recording),
    parseCodeIntelligenceQuery({
      ...common,
      id: 'query:definitions',
      capability: 'symbol-definitions',
      target: { kind: 'path', path: 'src/handler.ts' },
      retrievalReason: 'Find symbol definition for handler',
    }),
    parseCodeIntelligenceQuery({
      ...common,
      id: 'query:tests',
      capability: 'associated-tests',
      target: { kind: 'node', nodeId: 'handler' },
      retrievalReason: 'Find associated tests for handler',
    }),
  ];
}

function portableGraph(snapshot: CodeIntelligenceSnapshot) {
  return {
    nodes: snapshot.nodes.map((node) => ({ id: node.id, kind: node.kind, name: node.name, path: node.path, roles: node.roles })),
    edges: snapshot.edges.map((edge) => ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to })),
  };
}

describe('recorded provider conformance', () => {
  it('normalizes GitNexus and CGC recordings into the same portable graph facts', async () => {
    const [gitnexus, cgc] = await Promise.all([load('gitnexus'), load('cgc')]);
    expect(portableGraph(gitnexus.snapshot)).toEqual(portableGraph(cgc.snapshot));
    expect(gitnexus.snapshot.nodes[0]?.extension?.provider).toBe('gitnexus');
    expect(cgc.snapshot.nodes[0]?.extension?.provider).toBe('cgc');
  });

  it('preserves capability and licensing differences instead of inventing parity', async () => {
    const [gitnexus, cgc] = await Promise.all([load('gitnexus'), load('cgc')]);
    expect(gitnexus.snapshot.capabilities).toContain('native-impact');
    expect(cgc.snapshot.capabilities).not.toContain('native-impact');
    expect(gitnexus.descriptor.license.redistribution).toBe('conditional');
    expect(cgc.descriptor.license.spdx).toBe('MIT');
  });

  it('runs both recordings through one registry and provider interface', async () => {
    const [gitnexus, cgc] = await Promise.all([load('gitnexus'), load('cgc')]);
    const registry = new CodeIntelligenceProviderRegistry([
      { id: 'gitnexus', create: () => new RecordedCodeIntelligenceProvider(gitnexus) },
      { id: 'cgc', create: () => new RecordedCodeIntelligenceProvider(cgc) },
    ]);

    for (const id of registry.ids()) {
      const provider = registry.create(id);
      const recording = id === 'cgc' ? cgc : gitnexus;
      const descriptor = await provider.describe();
      expect(descriptor.id).toBe(id);

      const built = await provider.buildSnapshot(buildRequest(recording));
      expect(built.status).toBe('succeeded');
      expect(built.snapshot?.id).toBe(recording.snapshot.id);

      for (const query of commonQueries(recording)) {
        const result = await provider.query(query);
        assertQueryResultMatches(query, recording.snapshot, result);
        expect(result.status).toBe('complete');
        expect(result.facts.length).toBeGreaterThan(0);
      }
      await provider.close();
      await expect(provider.describe()).rejects.toThrow('is closed');
    }
  });

  it('fails a snapshot operation when an immutable source identity changes', async () => {
    const recording = await load('cgc');
    const provider = new RecordedCodeIntelligenceProvider(recording);
    const result = await provider.buildSnapshot({
      ...buildRequest(recording),
      revision: 'a'.repeat(40),
    });
    expect(result.status).toBe('failed');
    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe('identity-mismatch');
  });

  it('reports an unavailable capability as unsupported rather than empty', async () => {
    const recording = await load('cgc');
    const provider = new RecordedCodeIntelligenceProvider(recording);
    const query = parseCodeIntelligenceQuery({
      ...callersQuery(recording),
      id: 'query:native-impact',
      capability: 'native-impact',
      retrievalReason: 'Check native impact support',
    });
    const result = await provider.query(query);
    expect(result.status).toBe('unsupported');
    expect(result.facts).toEqual([]);
  });
});
