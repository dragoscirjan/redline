import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  assertQueryResultMatches,
  parseCodeIntelligenceProviderDescriptor,
  parseCodeIntelligenceQuery,
  parseCodeIntelligenceQueryResult,
  parseCodeIntelligenceRecording,
  providerCompatibilityDigest,
  snapshotCompatibilityDigest,
} from '../src/code-intelligence/contracts.js';
import type { CodeIntelligenceQuery, CodeIntelligenceRecording } from '../src/code-intelligence/types.js';

async function loadRecording(): Promise<{ raw: Record<string, unknown>; parsed: CodeIntelligenceRecording }> {
  const text = await readFile(new URL('./fixtures/code-intelligence/cgc.json', import.meta.url), 'utf8');
  const raw = JSON.parse(text) as Record<string, unknown>;
  return { raw, parsed: parseCodeIntelligenceRecording(raw) };
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

describe('code-intelligence contracts', () => {
  it('parses an exact, provenance-carrying provider recording', async () => {
    const { parsed } = await loadRecording();
    expect(parsed.descriptor.id).toBe('cgc');
    expect(parsed.snapshot.repositoryId).toBe('fixture-repo');
    expect(parsed.snapshot.nodes[0]?.provenance.source).toMatchObject({
      path: 'src/handler.ts',
    });
    expect(parsed.queryResults[0]?.status).toBe('complete');
  });

  it('rejects unknown contract fields rather than guessing provider output', async () => {
    const { raw } = await loadRecording();
    const snapshot = structuredClone(raw['snapshot']) as Record<string, unknown>;
    snapshot['providerSpecificGuess'] = true;
    const invalid = { ...raw, snapshot };
    expect(() => parseCodeIntelligenceRecording(invalid)).toThrow('snapshot contains unsupported fields');
  });

  it('rejects non-normalized repository paths', async () => {
    const { raw } = await loadRecording();
    const invalid = structuredClone(raw);
    const snapshot = invalid['snapshot'] as Record<string, unknown>;
    const nodes = snapshot['nodes'] as Array<Record<string, unknown>>;
    nodes[0]!['path'] = '../outside.ts';
    expect(() => parseCodeIntelligenceRecording(invalid)).toThrow('must be a normalized repository-relative path');
  });

  it('rejects facts whose immutable snapshot provenance does not match', async () => {
    const { raw } = await loadRecording();
    const invalid = structuredClone(raw);
    const snapshot = invalid['snapshot'] as Record<string, unknown>;
    const nodes = snapshot['nodes'] as Array<Record<string, unknown>>;
    const provenance = nodes[0]?.['provenance'] as Record<string, unknown>;
    provenance['revision'] = 'a'.repeat(40);
    expect(() => parseCodeIntelligenceRecording(invalid)).toThrow('provenance does not match its snapshot identity');
  });

  it('rejects recorded facts whose provenance does not match the enclosing query', async () => {
    const { raw } = await loadRecording();
    const invalid = structuredClone(raw);
    const results = invalid['queryResults'] as Array<Record<string, unknown>>;
    const facts = results[0]?.['facts'] as Array<Record<string, unknown>>;
    const edge = facts[0]?.['edge'] as Record<string, unknown>;
    const provenance = edge['provenance'] as Record<string, unknown>;
    provenance['queryId'] = 'query:definitions';
    expect(() => parseCodeIntelligenceRecording(invalid)).toThrow('does not match its enclosing query result');
  });

  it('keeps complete coverage consistent with language and file coverage', async () => {
    const { raw } = await loadRecording();
    const incompleteLanguage = structuredClone(raw);
    const languageSnapshot = incompleteLanguage['snapshot'] as Record<string, unknown>;
    const languages = languageSnapshot['languageCoverage'] as Array<Record<string, unknown>>;
    languages[0]!['indexedFiles'] = 1;
    expect(() => parseCodeIntelligenceRecording(incompleteLanguage)).toThrow(
      'complete coverage requires every discovered file to be indexed',
    );

    const failedFile = structuredClone(raw);
    const fileSnapshot = failedFile['snapshot'] as Record<string, unknown>;
    const files = fileSnapshot['fileCoverage'] as Array<Record<string, unknown>>;
    files[0]!['status'] = 'failed';
    expect(() => parseCodeIntelligenceRecording(failedFile)).toThrow(
      'snapshot.coverage cannot be complete when a language or file has reduced coverage',
    );
  });

  it('validates result identity, provenance, and deterministic query budgets', async () => {
    const { parsed } = await loadRecording();
    const query = callersQuery(parsed);
    const result = parsed.queryResults[0];
    if (result === undefined) throw new Error('recording must contain the callers result');
    expect(() => assertQueryResultMatches(query, parsed.snapshot, result)).not.toThrow();

    const tooSmall = { ...query, budget: { ...query.budget, maxResults: 1 } };
    expect(() => assertQueryResultMatches(tooSmall, parsed.snapshot, result)).toThrow('exceeds maxResults');
    expect(() => assertQueryResultMatches(
      { ...query, budget: { ...query.budget, maxDepth: 1 } },
      parsed.snapshot,
      { ...result, observedDepth: 2 },
    )).toThrow('exceeds maxDepth');
    expect(() => assertQueryResultMatches(
      { ...query, budget: { ...query.budget, maxFanOut: 1 } },
      parsed.snapshot,
      { ...result, observedMaxFanOut: 2 },
    )).toThrow('exceeds maxFanOut');

    const normalizedBytes = parseCodeIntelligenceQueryResult({ ...result, bytes: 0 });
    const byteBound = { ...query, budget: { ...query.budget, maxBytes: 1 } };
    expect(() => assertQueryResultMatches(byteBound, parsed.snapshot, normalizedBytes)).toThrow(
      'normalized query facts exceed maxBytes',
    );

    const rawMismatch = structuredClone(result) as unknown as Record<string, unknown>;
    const facts = rawMismatch['facts'] as Array<Record<string, unknown>>;
    const nodeFact = facts.find((fact) => fact['kind'] === 'node');
    if (nodeFact === undefined) throw new Error('recording must contain a node fact');
    const mismatchedNode = nodeFact['node'] as Record<string, unknown>;
    mismatchedNode['confidence'] = 0.1;
    const mismatch = parseCodeIntelligenceQueryResult(rawMismatch);
    expect(() => assertQueryResultMatches(query, parsed.snapshot, mismatch)).toThrow('does not match a node in the snapshot');
  });

  it('distinguishes empty, unsupported, unavailable, failed, truncated, and ambiguous results', async () => {
    const { parsed } = await loadRecording();
    const base = parsed.queryResults[0];
    if (base === undefined) throw new Error('recording must contain a result');
    for (const status of ['empty', 'unsupported', 'unavailable', 'failed', 'ambiguous'] as const) {
      const result = parseCodeIntelligenceQueryResult({
        ...base,
        status,
        facts: [],
        truncationReasons: [],
      });
      expect(result.status).toBe(status);
    }
    const truncated = parseCodeIntelligenceQueryResult({
      ...base,
      status: 'truncated',
      facts: [],
      truncationReasons: ['results'],
    });
    expect(truncated.truncationReasons).toEqual(['results']);
  });

  it('requires unsupported results when a snapshot lacks the queried capability', async () => {
    const { parsed } = await loadRecording();
    const query = parseCodeIntelligenceQuery({
      ...callersQuery(parsed),
      id: 'query:native-impact',
      capability: 'native-impact',
      retrievalReason: 'Check provider-native impact availability',
    });
    const unsupported = parseCodeIntelligenceQueryResult({
      version: 1,
      queryId: query.id,
      snapshotId: parsed.snapshot.id,
      revision: parsed.snapshot.revision,
      provider: parsed.snapshot.provider,
      providerVersion: parsed.snapshot.providerVersion,
      status: 'unsupported',
      facts: [],
      diagnostics: [],
      truncationReasons: [],
      observedDepth: 0,
      observedMaxFanOut: 0,
      bytes: 0,
      durationMs: 0,
    });
    expect(() => assertQueryResultMatches(query, parsed.snapshot, unsupported)).not.toThrow();
  });

  it('changes compatibility digests when provider or snapshot identities change', async () => {
    const { parsed } = await loadRecording();
    const providerDigest = providerCompatibilityDigest(parsed.descriptor);
    expect(() => parseCodeIntelligenceProviderDescriptor({
      ...parsed.descriptor,
      providerVersion: '0.6.14',
    })).toThrow('pinnedVersion must match providerVersion');
    const changedDescriptor = parseCodeIntelligenceProviderDescriptor({
      ...parsed.descriptor,
      providerVersion: '0.6.14',
      distribution: { ...parsed.descriptor.distribution, pinnedVersion: '0.6.14' },
    });
    expect(providerCompatibilityDigest(changedDescriptor)).not.toBe(providerDigest);

    const snapshotDigest = snapshotCompatibilityDigest(parsed.snapshot);
    expect(snapshotCompatibilityDigest({
      ...parsed.snapshot,
      configurationDigest: `sha256:${'9'.repeat(64)}`,
    })).not.toBe(snapshotDigest);
  });
});
