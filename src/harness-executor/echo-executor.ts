/**
 * Deterministic in-process harness used by tests and the CI harness matrix.
 *
 * Echo never spawns a process. It answers every prompt with a fixed `clean`
 * review document for the file the prompt targets, extracted from the
 * prompt's machine-readable manifest block. This keeps the full pipeline
 * (bundle -> prompt -> execution -> validation -> output) verifiable
 * without a model endpoint.
 */

import type {
  HarnessExecutor,
  HarnessPrompt,
  HarnessRun,
  HarnessSettings,
  PreparedHarness,
} from './types.js';

const FILE_ID_PATTERN = /"fileId"\s*:\s*"(\d{6})"/u;

export interface PreparedEcho extends PreparedHarness {
  readonly harness: 'echo';
}

export class EchoHarnessExecutor implements HarnessExecutor {
  readonly harness = 'echo' as const;

  async prepare(settings: HarnessSettings): Promise<PreparedEcho> {
    return Object.freeze({
      harness: 'echo',
      model: settings.model,
      description: 'in-process deterministic echo harness',
    });
  }

  async execute(_prepared: PreparedEcho, prompt: HarnessPrompt): Promise<HarnessRun> {
    const fileId = FILE_ID_PATTERN.exec(prompt.user)?.[1] ?? '000000';
    const text = JSON.stringify({ version: 1, fileId, outcome: 'clean', findings: [] });
    return {
      status: 'succeeded',
      harness: 'echo',
      exitCode: 0,
      text,
      diagnostic: '',
      durationMs: 0,
    };
  }
}
