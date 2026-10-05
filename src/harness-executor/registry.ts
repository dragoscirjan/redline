/**
 * Harness executor registry (Factory).
 *
 * Resolves a harness name to its executor implementation. Adding a harness
 * means adding one executor module and one registry entry; the review core
 * and the GitHub Action are unaffected.
 */

import { EchoHarnessExecutor } from './echo-executor.js';
import { createOpenCodeExecutor } from './opencode-executor.js';
import { createPiExecutor } from './pi-executor.js';
import type { ProcessSpawner } from './process-runner.js';
import { HARNESS_NAMES, type HarnessExecutor, type HarnessName } from './types.js';

export interface HarnessExecutorOptions {
  /** Harness binary override, used by tests and the CI matrix. */
  readonly command?: string;
  readonly spawner?: ProcessSpawner;
}

export function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value);
}

export function createHarnessExecutor(
  harness: HarnessName,
  options: HarnessExecutorOptions = {},
): HarnessExecutor {
  switch (harness) {
    case 'echo':
      return new EchoHarnessExecutor();
    case 'pi':
      return createPiExecutor({ command: options.command, spawner: options.spawner });
    case 'opencode':
      return createOpenCodeExecutor({ command: options.command, spawner: options.spawner });
    default: {
      const never: never = harness;
      throw new Error(`unsupported harness: ${String(never)}`);
    }
  }
}
