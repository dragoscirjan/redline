/** Application facade. Source capture and reporting do not own review policy. */
import type { ReviewEnvironment } from '../review/environment.ts';
import { runFileReviews, type ReviewRunInput, type ReviewRunResult } from '../review/runner.ts';
import type { ReviewWriter } from '../review/writer.ts';

export type ReviewEvent =
  | { readonly kind: 'started' }
  | { readonly kind: 'context-started'; readonly provider: string }
  | { readonly kind: 'context-ready'; readonly status: ReviewRunResult['summary']['codeContext']['status']; readonly relatedSpans: number; readonly fileOnlyFiles: number; readonly indexCache?: 'reused' | 'rebuilt' | 'uncached' | 'not-needed' | 'unavailable' | 'imported' }
  | { readonly kind: 'planned'; readonly files: readonly { readonly fileId: string; readonly reviewed: boolean }[] }
  | { readonly kind: 'file-started'; readonly fileId: string }
  | { readonly kind: 'file-completed'; readonly fileId: string; readonly outcome: 'clean' | 'findings' | 'omitted' }
  | { readonly kind: 'cleanup-failed' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed' };

export interface CaptureCoverage {
  readonly excludedUntrackedFiles: number;
  readonly omittedSourceFiles: number;
  readonly inertSymlinks: number;
  readonly inertSubmodules: number;
}

export interface CapturedContextSnapshot {
  readonly repository: string;
  readonly base: string;
  readonly head: string;
  prepareSources(baseDirectory?: string): Promise<{ readonly baseDirectory: string; readonly headDirectory: string }>;
}

export interface CapturedRevision {
  readonly reviewDirectory: string;
  readonly sourceDirectory: string;
  readonly coverage?: CaptureCoverage;
  readonly contextSnapshot?: CapturedContextSnapshot;
  dispose(): Promise<void>;
}

export interface RevisionSource {
  capture(signal: AbortSignal): Promise<CapturedRevision>;
}

/** Publication-safe projection; raw per-file model output never reaches reporters. */
export interface ReviewReport {
  readonly review: ReviewRunResult['review'];
  readonly summary: ReviewRunResult['summary'];
  readonly outputDirectory: string;
  readonly captureCoverage?: CaptureCoverage;
  readonly omissions: readonly { readonly path: string; readonly errorKind: string }[];
}

export interface ReviewReporter {
  readonly id: string;
  preflight(): Promise<void>;
  progress(event: ReviewEvent): void;
  complete(result: ReviewReport): Promise<void>;
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
      try { reporter.progress(structuredClone(event)); } catch { this.failures.add(reporter.id); }
    }
  }
  async complete(result: ReviewReport): Promise<void> {
    for (const reporter of this.reporters) {
      // Each adapter gets its own copy. One reporter cannot change another
      // reporter's output or the runner's already-written authoritative result.
      try { await reporter.complete(structuredClone(result)); } catch { this.failures.add(reporter.id); }
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
  readonly prepareContext?: (capture: CapturedRevision, signal: AbortSignal) => Promise<ReviewEnvironment['codeContext']>;
}

export class ReviewApplication {
  private readonly dependencies: ReviewApplicationDependencies;
  constructor(dependencies: ReviewApplicationDependencies) { this.dependencies = dependencies; }
  async run(command: ReviewCommand, signal: AbortSignal): Promise<ReviewRunResult> {
    const { source, reporter } = this.dependencies;
    await reporter.preflight();
    signal.throwIfAborted();
    reporter.progress({ kind: 'started' });
    let captured: CapturedRevision | undefined;
    try {
      captured = await source.capture(signal);
      signal.throwIfAborted();
      const codeContext = this.dependencies.prepareContext === undefined ? command.environment.codeContext
        : await this.dependencies.prepareContext(captured, signal);
      signal.throwIfAborted();
      const result = await (this.dependencies.execute ?? executePreparedReview)({
        environment: { ...command.environment, reviewDirectory: captured.reviewDirectory, sourceDirectory: captured.sourceDirectory, codeContext },
        ...(this.dependencies.artifacts === undefined ? {} : { writer: this.dependencies.artifacts }),
        onReviewPlan: (files) => reporter.progress({ kind: 'planned', files }),
        onFileStart: ({ fileId }) => reporter.progress({ kind: 'file-started', fileId }),
        onFileDone: ({ fileId, outcome }) => reporter.progress({ kind: 'file-completed', fileId, outcome }),
      });
      signal.throwIfAborted();
      await reporter.complete({
        review: result.review, summary: result.summary, outputDirectory: result.outputDirectory,
        ...(captured.coverage === undefined ? {} : { captureCoverage: captured.coverage }),
        omissions: result.records.filter((record) => record.outcome === 'omitted').map((record) => ({
          path: record.path, errorKind: record.errorKind ?? 'omitted',
        })),
      });
      reporter.progress({ kind: 'completed' });
      return result;
    } catch (error) {
      reporter.progress({ kind: 'failed' });
      throw error;
    } finally {
      try { await captured?.dispose(); }
      catch {
        // Cleanup diagnostics must not replace a completed review or its original failure.
        reporter.progress({ kind: 'cleanup-failed' });
      }
    }
  }
}
