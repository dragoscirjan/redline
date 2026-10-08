import { describe, expect, it } from 'vitest';
import { CodeIntelligenceProviderRegistry } from '../src/code-intelligence/registry.js';
import type {
  CodeIntelligenceProvider,
  CodeIntelligenceProviderDescriptor,
  CodeIntelligenceQuery,
  CodeIntelligenceQueryResult,
  SnapshotBuildRequest,
  SnapshotOpenRequest,
  SnapshotOperationResult,
} from '../src/code-intelligence/types.js';

class StubProvider implements CodeIntelligenceProvider {
  constructor(readonly id: string) {}

  async describe(): Promise<CodeIntelligenceProviderDescriptor> {
    throw new Error('not used');
  }

  async buildSnapshot(_request: SnapshotBuildRequest): Promise<SnapshotOperationResult> {
    throw new Error('not used');
  }

  async openSnapshot(_request: SnapshotOpenRequest): Promise<SnapshotOperationResult> {
    throw new Error('not used');
  }

  async query(_query: CodeIntelligenceQuery): Promise<CodeIntelligenceQueryResult> {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

describe('CodeIntelligenceProviderRegistry', () => {
  it('creates registered providers without review-domain branching', () => {
    let creations = 0;
    const registry = new CodeIntelligenceProviderRegistry([
      { id: 'fixture', create: () => { creations += 1; return new StubProvider('fixture'); } },
    ]);

    expect(registry.has('fixture')).toBe(true);
    expect(registry.create('fixture').id).toBe('fixture');
    expect(registry.create('fixture')).not.toBe(registry.create('fixture'));
    expect(creations).toBe(3);
  });

  it('uses runtime-independent ordering and immutable extension', () => {
    const original = new CodeIntelligenceProviderRegistry([
      { id: 'a_', create: () => new StubProvider('a_') },
      { id: 'a-', create: () => new StubProvider('a-') },
    ]);
    const extended = original.with({ id: 'A', create: () => new StubProvider('A') });

    expect(original.ids()).toEqual(['a-', 'a_']);
    expect(extended.ids()).toEqual(['A', 'a-', 'a_']);
    expect(original.has('A')).toBe(false);
  });

  it('fails closed for duplicates, unknown providers, and mismatched factories', () => {
    expect(() => new CodeIntelligenceProviderRegistry([
      { id: 'same', create: () => new StubProvider('same') },
      { id: 'same', create: () => new StubProvider('same') },
    ])).toThrow('duplicate code-intelligence provider');

    const registry = new CodeIntelligenceProviderRegistry([
      { id: 'expected', create: () => new StubProvider('different') },
    ]);
    expect(() => registry.create('missing')).toThrow('unsupported code-intelligence provider');
    expect(() => registry.create('expected')).toThrow('created mismatched provider');
  });

  it('rejects invalid provider identities at registration time', () => {
    expect(() => new CodeIntelligenceProviderRegistry([
      { id: '../escape', create: () => new StubProvider('../escape') },
    ])).toThrow('invalid code-intelligence provider id');
  });
});
