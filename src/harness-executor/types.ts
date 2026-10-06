/**
 * Harness executor contracts.
 *
 * A harness executor adapts the generic review-execution contract to one
 * coding-agent harness (Pi, OpenCode, ...). Each implementation owns every
 * harness-specific concern: generated configuration, credential handoff,
 * model selection, non-interactive invocation with tools disabled, bounded
 * output capture, and timeouts. The review core stays free of harness
 * specifics and only sees this interface (Strategy pattern).
 */

export type HarnessName = 'echo' | 'pi' | 'opencode';

export const HARNESS_NAMES: readonly HarnessName[] = ['echo', 'pi', 'opencode'];

export interface HarnessModelTarget {
  readonly provider: string;
  readonly endpoint: string;
  readonly model: string;
}

export interface HarnessCredential {
  readonly provider: string;
  readonly value: string;
}

export interface HarnessSettings {
  readonly model: HarnessModelTarget;
  /**
   * Selected provider credential. `undefined` selects endpoints that need no
   * authentication (for example a loopback local-model server).
   */
  readonly credential: HarnessCredential | undefined;
  readonly timeoutMs: number;
  /** Caller-managed scratch directory for generated harness configuration. */
  readonly workDirectory: string;
}

export interface HarnessPrompt {
  readonly system: string;
  readonly user: string;
}

export type HarnessRunStatus = 'succeeded' | 'failed' | 'timed-out';

export interface HarnessRun {
  readonly status: HarnessRunStatus;
  readonly harness: HarnessName;
  readonly exitCode: number | null;
  /** Extracted assistant text. Empty when the harness produced none. */
  readonly text: string;
  /** Bounded diagnostic (stderr and similar) for failure reporting. */
  readonly diagnostic: string;
  readonly durationMs: number;
}

/** Harness-specific state prepared once per review run and reused per prompt. */
export interface PreparedHarness {
  readonly harness: HarnessName;
  readonly model: HarnessModelTarget;
  /**
   * Human-readable description of the generated configuration for run
   * summaries and diagnostics. Must never contain credential values.
   */
  readonly description: string;
}

export interface HarnessOutputLine {
  readonly stream: 'stdout' | 'stderr';
  /**
   * `line` is a complete, self-contained log line (prefixed by the CLI);
   * `text` is a raw fragment of the model's streaming output, written to
   * the log unprefixed so consecutive fragments read as continuous text.
   */
  readonly kind: 'line' | 'text';
  readonly line: string;
}

export interface HarnessExecuteOptions {
  /** Live per-line harness output tap for progress logging; optional. */
  readonly onOutputLine?: (output: HarnessOutputLine) => void;
}

export interface HarnessExecutor {
  readonly harness: HarnessName;
  prepare(settings: HarnessSettings): Promise<PreparedHarness>;
  execute(prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun>;
}
