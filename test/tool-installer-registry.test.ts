import { describe, expect, it } from 'vitest';
import { ToolInstallerRegistry } from '../src/artifact-cache/registry.js';
import type {
  ToolInstallationResult,
  ToolInstaller,
  ToolInstallRequest,
  ToolValidationRequest,
  ToolValidationResult,
} from '../src/artifact-cache/types.js';

class StubInstaller implements ToolInstaller {
  constructor(readonly id: string) {}

  async install(_request: ToolInstallRequest): Promise<ToolInstallationResult> {
    return { status: 'unavailable', diagnostics: [], durationMs: 0 };
  }

  async validate(_request: ToolValidationRequest): Promise<ToolValidationResult> {
    return { status: 'unavailable', diagnostics: [], durationMs: 0 };
  }
}

describe('ToolInstallerRegistry', () => {
  it('creates fresh dependency-injected installers', () => {
    let creations = 0;
    const registry = new ToolInstallerRegistry([
      { id: 'gitnexus', create: () => { creations += 1; return new StubInstaller('gitnexus'); } },
    ]);
    expect(registry.has('gitnexus')).toBe(true);
    expect(registry.create('gitnexus')).not.toBe(registry.create('gitnexus'));
    expect(creations).toBe(2);
  });

  it('uses raw deterministic ordering and immutable extension', () => {
    const original = new ToolInstallerRegistry([
      { id: 'a_', create: () => new StubInstaller('a_') },
      { id: 'a-', create: () => new StubInstaller('a-') },
    ]);
    const extended = original.with({ id: 'A', create: () => new StubInstaller('A') });
    expect(original.ids()).toEqual(['a-', 'a_']);
    expect(extended.ids()).toEqual(['A', 'a-', 'a_']);
    expect(original.has('A')).toBe(false);
  });

  it('does not retain mutable registration aliases', () => {
    const registration = { id: 'stable', create: () => new StubInstaller('stable') };
    const registry = new ToolInstallerRegistry([registration]);
    const extended = registry.with({ id: 'extra', create: () => new StubInstaller('extra') });
    registration.create = () => new StubInstaller('changed');
    expect(registry.create('stable').id).toBe('stable');
    expect(extended.create('stable').id).toBe('stable');
  });

  it('rejects invalid, duplicate, unknown, and mismatched installers', () => {
    expect(() => new ToolInstallerRegistry([
      { id: '../escape', create: () => new StubInstaller('../escape') },
    ])).toThrow('invalid tool installer id');
    expect(() => new ToolInstallerRegistry([
      { id: 'same', create: () => new StubInstaller('same') },
      { id: 'same', create: () => new StubInstaller('same') },
    ])).toThrow('duplicate tool installer');
    const registry = new ToolInstallerRegistry([
      { id: 'expected', create: () => new StubInstaller('different') },
    ]);
    expect(() => registry.create('missing')).toThrow('unsupported tool installer');
    expect(() => registry.create('expected')).toThrow('created mismatched installer');
  });
});
