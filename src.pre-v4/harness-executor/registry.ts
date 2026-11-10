/**
 * Harness executor registry (Factory).
 *
 * Resolves a harness name to its executor implementation. Adding a harness
 * means adding one executor module and one registry entry; the review core
 * and the GitHub Action are unaffected.
 */

import { EchoHarnessExecutor } from './echo-executor.ts';
import { createOpenCodeExecutor } from './opencode-executor.ts';
import { createPiExecutor } from './pi-executor.ts';
import type { ProcessSpawner } from './process-runner.ts';
import type { NativeHarnessContext } from './native.ts';
import { HARNESS_NAMES, type HarnessExecutor, type HarnessName } from './types.ts';

export interface HarnessExecutorOptions {
  /** Harness binary override, used by tests and the CI matrix. */
  readonly command?: string;
  readonly spawner?: ProcessSpawner;
  /** Local CLI/Docker only; omitted by the isolated Actions entry point. */
  readonly native?: NativeHarnessContext;
}

export function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value);
}

/** Select a registered harness implementation and pass through injected launch dependencies; unsupported names fail explicitly. */
export function createHarnessExecutor(
  harness: HarnessName,
  options: HarnessExecutorOptions = {},
): HarnessExecutor {
  switch (harness) {
    case 'echo':
      return new EchoHarnessExecutor();
    case 'pi':
      return createPiExecutor({ command: options.command, spawner: options.spawner, native: options.native });
    case 'opencode':
      return createOpenCodeExecutor({ command: options.command, spawner: options.spawner, native: options.native });
    default: {
      const never: never = harness;
      throw new Error(`unsupported harness: ${String(never)}`);
    }
  }
}
