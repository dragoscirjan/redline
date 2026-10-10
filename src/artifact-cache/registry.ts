import type {
  ToolInstaller,
  ToolInstallerRegistration,
} from './types.js';

const INSTALLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRegistration(registration: ToolInstallerRegistration): void {
  if (!INSTALLER_ID_PATTERN.test(registration.id)) {
    throw new Error(`invalid tool installer id: ${registration.id}`);
  }
  if (typeof registration.create !== 'function') {
    throw new Error(`tool installer ${registration.id} requires a factory`);
  }
}

/** Dependency-injected installer registry with no tool-name branching in consumers. */
export class ToolInstallerRegistry {
  readonly #registrations: ReadonlyMap<string, ToolInstallerRegistration>;

  constructor(registrations: readonly ToolInstallerRegistration[] = []) {
    const indexed = new Map<string, ToolInstallerRegistration>();
    for (const registration of registrations) {
      validateRegistration(registration);
      if (indexed.has(registration.id)) throw new Error(`duplicate tool installer: ${registration.id}`);
      indexed.set(registration.id, {
        id: registration.id,
        create: registration.create,
      });
    }
    this.#registrations = indexed;
  }

  has(id: string): boolean {
    return this.#registrations.has(id);
  }

  ids(): readonly string[] {
    return [...this.#registrations.keys()].sort(compareText);
  }

  create(id: string): ToolInstaller {
    const registration = this.#registrations.get(id);
    if (registration === undefined) throw new Error(`unsupported tool installer: ${id}`);
    const installer = registration.create();
    if (installer.id !== id) {
      throw new Error(`tool installer factory ${id} created mismatched installer ${installer.id}`);
    }
    return installer;
  }

  with(registration: ToolInstallerRegistration): ToolInstallerRegistry {
    validateRegistration(registration);
    if (this.#registrations.has(registration.id)) {
      throw new Error(`duplicate tool installer: ${registration.id}`);
    }
    return new ToolInstallerRegistry([...this.#registrations.values(), registration]);
  }
}
