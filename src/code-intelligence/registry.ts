/**
 * Dependency-injected provider registry.
 *
 * The review domain receives this abstraction and never branches on GitNexus,
 * CGC, or any future provider name.
 */

import type {
  CodeIntelligenceProvider,
  CodeIntelligenceProviderRegistration,
} from './types.js';

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRegistration(registration: CodeIntelligenceProviderRegistration): void {
  if (!PROVIDER_ID_PATTERN.test(registration.id)) {
    throw new Error(`invalid code-intelligence provider id: ${registration.id}`);
  }
  if (typeof registration.create !== 'function') {
    throw new Error(`provider ${registration.id} requires a factory`);
  }
}

export class CodeIntelligenceProviderRegistry {
  readonly #registrations: ReadonlyMap<string, CodeIntelligenceProviderRegistration>;

  constructor(registrations: readonly CodeIntelligenceProviderRegistration[] = []) {
    const indexed = new Map<string, CodeIntelligenceProviderRegistration>();
    for (const registration of registrations) {
      validateRegistration(registration);
      if (indexed.has(registration.id)) {
        throw new Error(`duplicate code-intelligence provider: ${registration.id}`);
      }
      indexed.set(registration.id, registration);
    }
    this.#registrations = indexed;
  }

  has(id: string): boolean {
    return this.#registrations.has(id);
  }

  ids(): readonly string[] {
    return [...this.#registrations.keys()].sort(compareText);
  }

  create(id: string): CodeIntelligenceProvider {
    const registration = this.#registrations.get(id);
    if (registration === undefined) throw new Error(`unsupported code-intelligence provider: ${id}`);
    const provider = registration.create();
    if (provider.id !== id) {
      throw new Error(`provider factory ${id} created mismatched provider ${provider.id}`);
    }
    return provider;
  }

  /** Returns a new registry so caller-owned registries remain immutable. */
  with(registration: CodeIntelligenceProviderRegistration): CodeIntelligenceProviderRegistry {
    validateRegistration(registration);
    if (this.#registrations.has(registration.id)) {
      throw new Error(`duplicate code-intelligence provider: ${registration.id}`);
    }
    return new CodeIntelligenceProviderRegistry([
      ...this.#registrations.values(),
      registration,
    ]);
  }
}
