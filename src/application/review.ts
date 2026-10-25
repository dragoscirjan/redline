/** Application facade. Source capture and reporting do not own review policy. */
import type { ReviewEnvironment } from '../review/environment.ts';
import { runFileReviews, type ReviewRunInput, type ReviewRunResult } from '../review/runner.ts';
import type { ReviewWriter } from '../review/writer.ts';

export type ReviewEvent =
  | { readonly kind: 'started' }
  | { readonly kind: 'file-started'; readonly fileId: string }
  | { readonly kind: 'file-completed'; readonly fileId: string; readonly outcome: 'clean' | 'findings' | 'omitted' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed' };

export interface CapturedRevision {
  readonly reviewDirectory: string;
  readonly sourceDirectory: string;
  dispose(): Promise<void>;
}

export interface RevisionSource {
  capture(signal: AbortSignal): Promise<CapturedRevision>;
}

export interface ReviewReporter {
  readonly id: string;
  preflight(): Promise<void>;
  progress(event: ReviewEvent): void;
  complete(result: ReviewRunResult): Promise<void>;
}

/** Reporting failures are isolated; a failed preflight still aborts before capture. */
export class CompositeReporter implements ReviewReporter {
  readonly id = 'composite';
  readonly failures = new Set<string>();
  private readonly reporters: readonly ReviewReporter[];
  constructor(reporters: readonly ReviewReporter[]) { this.reporters = reporters; }
  async preflight(): Promise<void> {
    for (const reporter of this.reporters) await reporter.preflight();
  }
  progress(event: ReviewEvent): void {
    for (const reporter of this.reporters) {
      try { reporter.progress(event); } catch { this.failures.add(reporter.id); }
    }
  }
  async complete(result: ReviewRunResult): Promise<void> {
    for (const reporter of this.reporters) {
      try { await reporter.complete(result); } catch { this.failures.add(reporter.id); }
    }
  }
}

/** Prepared-bundle adapter retained for the legacy environment entrypoint. */
export function executePreparedReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  return runFileReviews(input);
}

export interface ReviewCommand {
  readonly environment: Omit<ReviewEnvironment, 'reviewDirectory' | 'sourceDirectory'>;
}

export interface ReviewApplicationDependencies {
  readonly source: RevisionSource;
  readonly reporter: CompositeReporter;
  readonly execute?: (input: ReviewRunInput) => Promise<ReviewRunResult>;
  readonly artifacts?: ReviewWriter;
}

export class ReviewApplication {
  private readonly dependencies: ReviewApplicationDependencies;
  constructor(dependencies: ReviewApplicationDependencies) { this.dependencies = dependencies; }
  async run(command: ReviewCommand, signal: AbortSignal): Promise<ReviewRunResult> {
    const { source, reporter } = this.dependencies;
    await reporter.preflight();
    signal.throwIfAborted();
    reporter.progress({ kind: 'started' });
    const captured = await source.capture(signal);
    try {
      signal.throwIfAborted();
      const result = await (this.dependencies.execute ?? executePreparedReview)({
        environment: { ...command.environment, reviewDirectory: captured.reviewDirectory, sourceDirectory: captured.sourceDirectory },
        ...(this.dependencies.artifacts === undefined ? {} : { writer: this.dependencies.artifacts }),
        onFileStart: ({ fileId }) => reporter.progress({ kind: 'file-started', fileId }),
        onFileDone: ({ fileId, outcome }) => reporter.progress({ kind: 'file-completed', fileId, outcome }),
      });
      signal.throwIfAborted();
      await reporter.complete(result);
      reporter.progress({ kind: 'completed' });
      return result;
    } catch (error) {
      reporter.progress({ kind: 'failed' });
      throw error;
    } finally {
      await captured.dispose();
    }
  }
}
