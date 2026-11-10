#!/usr/bin/env node
/**
 * Review tool command-line entry point.
 *
 * Runs standalone (`redline-review`) and as the GitHub Action component: the
 * action sets the `REDLINE_*` environment contract and invokes this CLI
 * twice — first with `--validate-only` for authoritative input validation,
 * then for the review run itself.
 */

import { pathToFileURL } from 'node:url';
import { executePreparedReview } from '../application/review.ts';
import {
  GitHubReviewPublisher,
  PublicationService,
  type PublicationOutcome,
  type RunningSummaryInfo,
  publishRecords,
} from '../publish/index.ts';
import type { ReviewPublisher } from '../publish/index.ts';
import type { FileReviewRecord } from './types.ts';
import {
  parseAnnounceEnvironment,
  parseFailureReason,
  parsePublishOnlyEnvironment,
  parseReviewEnvironment,
  type ReviewVerbosity,
} from './environment.ts';
import { loadPublishedRun } from './run-output.ts';
import {
  type FileHarnessOutputEvent,
  type FileReviewIdentity,
  type ReviewRunInput,
} from './runner.ts';

const USAGE_ERROR_EXIT = 2;
const RUN_FAILURE_EXIT = 1;
const MAX_LIVE_OUTPUT_CHARS_PER_FILE = 32 * 1024;
const MAX_PROGRESS_DIAGNOSTIC_LINES_PER_FILE = 16;
const MAX_PROGRESS_ACTIVITY_UPDATES_PER_FILE = 8;
const PROGRESS_ACTIVITY_INTERVAL = 25;

function writeLine(stream: NodeJS.WriteStream, value: string): void {
  stream.write(`${value}\n`);
}

/** One bounded stderr line per completed file: live progress in the run log. */
function progressLine(record: FileReviewRecord): void {
  const error = record.errorKind !== undefined ? ` (${record.errorKind})` : '';
  const execution = record.execution === 'reused' ? ' [reused]' : '';
  writeLine(process.stderr, `redline-review: [${record.fileId} ${record.path}] ${record.outcome}${error}${execution}`);
}

/** Marks the start of a file's review in the run log. */
function fileStartLine(file: FileReviewIdentity): void {
  writeLine(process.stderr, `redline-review: [${file.fileId} ${file.path}] reviewing…`);
}

function classifyProgressDiagnostic(line: string): string {
  if (/rate.?limit|too many requests|\b429\b/iu.test(line)) return 'rate-limit';
  if (/unauthori[sz]ed|forbidden|api.?key|\b401\b|\b403\b/iu.test(line)) return 'authentication';
  if (/timed?\s*out|deadline/iu.test(line)) return 'timeout';
  if (/connect|socket|dns|network|econn/iu.test(line)) return 'connection';
  if (/retry|backoff/iu.test(line)) return 'retry';
  if (/\b5\d\d\b|server error|service unavailable/iu.test(line)) return 'provider-server';
  return 'other';
}

/**
 * Maps the verbosity level to the runner's progress callbacks. Executed
 * files emit start/done lines; restored files emit one reused completion
 * line. The level controls only the live model stream.
 */
export function progressCallbacks(verbosity: ReviewVerbosity): {
  onFileStart: typeof fileStartLine;
  onFileDone: typeof progressLine;
  onHarnessOutput?: ReviewRunInput['onHarnessOutput'];
  harnessStreamMode?: 'dots' | 'text';
} {
  if (verbosity === 'silent') {
    return { onFileStart: fileStartLine, onFileDone: progressLine };
  }
  if (verbosity === 'progress') {
    const textChunks = new Map<string, number>();
    const activityUpdates = new Map<string, number>();
    const diagnosticLines = new Map<string, number>();
    return {
      onFileStart: fileStartLine,
      onHarnessOutput(output) {
        if (output.kind === 'text') {
          const chunks = (textChunks.get(output.fileId) ?? 0) + 1;
          textChunks.set(output.fileId, chunks);
          const updates = activityUpdates.get(output.fileId) ?? 0;
          if (updates < MAX_PROGRESS_ACTIVITY_UPDATES_PER_FILE
            && (chunks === 1 || chunks % PROGRESS_ACTIVITY_INTERVAL === 0)) {
            activityUpdates.set(output.fileId, updates + 1);
            writeLine(process.stderr, `redline-review: [${output.fileId} ${output.path}] model activity: ${chunks} text chunks`);
          }
          return;
        }
        const used = diagnosticLines.get(output.fileId) ?? 0;
        if (used >= MAX_PROGRESS_DIAGNOSTIC_LINES_PER_FILE) return;
        diagnosticLines.set(output.fileId, used + 1);
        const lineLength = Array.from(output.line).length;
        const category = classifyProgressDiagnostic(output.line);
        writeLine(process.stderr, `redline-review: [${output.fileId} ${output.path}] harness ${output.stream} diagnostic: ${category} (${lineLength} chars)`);
      },
      onFileDone(record) {
        const chunks = textChunks.get(record.fileId) ?? 0;
        if (chunks > 0) {
          writeLine(process.stderr, `redline-review: [${record.fileId} ${record.path}] model stream: ${chunks} text chunks`);
        }
        progressLine(record);
      },
      harnessStreamMode: 'dots',
    };
  }
  const emitted = new Map<string, number>();
  const truncated = new Set<string>();
  const harnessLine = (output: FileHarnessOutputEvent): void => {
    const used = emitted.get(output.fileId) ?? 0;
    if (used >= MAX_LIVE_OUTPUT_CHARS_PER_FILE) return;
    const payload = output.line.replaceAll(/\r\n|[\r\n]/gu, ' ↵ ').slice(0, 200);
    const rendered = `redline-review: [${output.fileId} ${output.path}] harness ${output.stream}: ${payload}`;
    const bounded = rendered.slice(0, MAX_LIVE_OUTPUT_CHARS_PER_FILE - used);
    emitted.set(output.fileId, used + bounded.length);
    writeLine(process.stderr, bounded);
    if (bounded.length < rendered.length && !truncated.has(output.fileId)) {
      truncated.add(output.fileId);
      writeLine(process.stderr, `redline-review: [${output.fileId} ${output.path}] live harness output truncated`);
    }
  };
  return {
    onFileStart: fileStartLine,
    onFileDone: progressLine,
    onHarnessOutput: harnessLine,
    harnessStreamMode: 'text',
  };
}

export interface CliDependencies {
  /** Publisher override for tests; defaults to the GitHub adapter. */
  readonly publisher?: ReviewPublisher;
  /** Trusted action-only opt-in. The standalone CLI never enables verifier publication. */
  readonly reviewOptions?: Pick<ReviewRunInput, 'verifyCandidates' | 'followUpExecutor'>;
}

/**
 * Single-purpose modes for the composite action's two-phase token flow:
 * the announce modes run before the review (fresh token 1); publish-only
 * runs after the review (fresh token 2) and re-reads what the review
 * wrote from disk. A failure exits non-zero; the announce steps are
 * continue-on-error in the action, so a notification problem never
 * blocks the review.
 */
async function runSinglePurposeMode(
  mode: '--announce-only' | '--announce-failure' | '--publish-only',
  environment: NodeJS.ProcessEnv,
  dependencies: CliDependencies,
): Promise<number> {
  try {
    if (mode === '--publish-only') {
      const parsed = parsePublishOnlyEnvironment(environment);
      const publisher = dependencies.publisher ?? new GitHubReviewPublisher({ token: parsed.publication.token });
      const run = await loadPublishedRun(parsed.outputDirectory);
      // The saved run must be the run for THIS publication head: an output
      // directory left over from an earlier attempt would otherwise pass
      // the PR stale-head check while publishing another commit's
      // findings.
      if (run.review.head !== parsed.publication.head) {
        throw new Error(
          `review output belongs to head ${run.review.head.slice(0, 12)}, not the publication head ${parsed.publication.head.slice(0, 12)}`,
        );
      }
      const outcome = await publishRecords({
        records: run.records,
        review: run.review,
        publication: parsed.publication,
        publisher,
      });
      writeLine(process.stdout, JSON.stringify(publicationReport(outcome)));
      const requested = outcome.files.length;
      if (requested > 0 && outcome.publishedFileReviews === 0 && outcome.failedFileReviews > 0) {
        return RUN_FAILURE_EXIT;
      }
      return 0;
    }
    const parsed = parseAnnounceEnvironment(environment);
    const publisher = dependencies.publisher ?? new GitHubReviewPublisher({ token: parsed.publication.token });
    const service = new PublicationService(publisher, {
      repository: parsed.publication.repository,
      pullRequest: parsed.publication.pullRequest,
      head: parsed.publication.head,
    });
    const info: RunningSummaryInfo = {
      harness: parsed.harness,
      model: parsed.model,
      startedAt: new Date().toISOString(),
    };
    if (mode === '--announce-failure') {
      // The reason becomes published text: bounded, control characters
      // stripped, and the token redacted defensively.
      const reason = parseFailureReason(environment.REDLINE_FAILURE_REASON)
        .split(parsed.publication.token)
        .join('[redacted]');
      await service.announceFailure(
        info,
        reason.length > 0 ? reason : 'The review run failed; see the run log and artifacts for diagnostics.',
      );
      return 0;
    }
    await service.announceStart(info);
    return 0;
  } catch (error) {
    writeLine(
      process.stderr,
      `redline-review: ${mode.slice(2)} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return RUN_FAILURE_EXIT;
  }
}

export async function main(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const modes = ['--validate-only', '--announce-only', '--announce-failure', '--publish-only'].filter((mode) =>
    arguments_.includes(mode),
  );
  if (modes.length > 1 || arguments_.some((argument) => !modes.includes(argument))) {
    writeLine(
      process.stderr,
      'redline-review: unsupported argument (only one of --validate-only, --announce-only, --announce-failure, --publish-only is accepted)',
    );
    return USAGE_ERROR_EXIT;
  }
  const mode = modes[0];
  if (mode !== undefined && mode !== '--validate-only') {
    return runSinglePurposeMode(
      mode as '--announce-only' | '--announce-failure' | '--publish-only',
      environment,
      dependencies,
    );
  }
  const validateOnly = mode === '--validate-only';

  let parsed;
  try {
    parsed = parseReviewEnvironment(environment);
  } catch (error) {
    writeLine(process.stderr, `redline-review: ${error instanceof Error ? error.message : String(error)}`);
    return validateOnly ? USAGE_ERROR_EXIT : RUN_FAILURE_EXIT;
  }

  if (validateOnly) {
    writeLine(
      process.stdout,
      JSON.stringify(
        parsed.mode === 'review'
          ? {
              mode: 'review',
              harness: parsed.review?.harness,
              publication: parsed.publication !== undefined,
              timeoutMinutes: parsed.timeout.minutes,
              fileTimeoutMinutes: parsed.timeout.minutes,
              runTimeoutMinutes: parsed.runTimeout.minutes,
              reviewConcurrency: parsed.review?.reviewConcurrency,
            }
          : {
              mode: 'context-only',
              timeoutMinutes: parsed.timeout.minutes,
              fileTimeoutMinutes: parsed.timeout.minutes,
              runTimeoutMinutes: parsed.runTimeout.minutes,
            },
      ),
    );
    return 0;
  }

  if (parsed.mode === 'context-only') {
    writeLine(process.stdout, JSON.stringify({ mode: 'context-only' }));
    return 0;
  }

  try {
    const review = parsed.review as NonNullable<typeof parsed.review>;
    if (parsed.publication !== undefined) {
      const publisher = dependencies.publisher ?? new GitHubReviewPublisher({ token: parsed.publication.token });
      const service = new PublicationService(publisher, {
        repository: parsed.publication.repository,
        pullRequest: parsed.publication.pullRequest,
        head: parsed.publication.head,
      });
      // The start notification goes out before the review executes: a run
      // can take tens of minutes, and the PR must not look abandoned. A
      // failed announcement never aborts the run — the artifacts remain
      // the guaranteed output.
      const running: RunningSummaryInfo = {
        harness: review.harness,
        model: review.model.model,
        startedAt: new Date().toISOString(),
      };
      try {
        await service.announceStart(running);
      } catch (error) {
        writeLine(
          process.stderr,
          `redline-review: start notification failed (continuing): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let result;
      try {
        result = await executePreparedReview({ ...progressCallbacks(parsed.verbosity), environment: review, ...dependencies.reviewOptions });
      } catch (error) {
        // Defense in depth: the failure text is published, so the
        // publication token must never appear in it.
        const message = (error instanceof Error ? error.message : String(error))
          .split(parsed.publication.token)
          .join('[redacted]');
        try {
          await service.announceFailure(running, message);
        } catch (notifyError) {
          writeLine(
            process.stderr,
            `redline-review: failure notification failed: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`,
          );
        }
        throw error;
      }
      writeLine(process.stdout, JSON.stringify(result.summary));

      let exitCode = result.exitCode;
      try {
        const publication = await service.publish(result.records, result.review);
        writeLine(process.stdout, JSON.stringify(publicationReport(publication)));
        const requested = publication.files.length;
        if (requested > 0 && publication.publishedFileReviews === 0 && publication.failedFileReviews > 0) {
          exitCode = RUN_FAILURE_EXIT;
        }
      } catch (error) {
        writeLine(
          process.stderr,
          `redline-review: publication failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        exitCode = RUN_FAILURE_EXIT;
      }
      return exitCode;
    }

    const result = await executePreparedReview({ ...progressCallbacks(parsed.verbosity), environment: review, ...dependencies.reviewOptions });
    writeLine(process.stdout, JSON.stringify(result.summary));
    return result.exitCode;
  } catch (error) {
    writeLine(process.stderr, `redline-review: ${error instanceof Error ? error.message : String(error)}`);
    return RUN_FAILURE_EXIT;
  }
}

function publicationReport(publication: PublicationOutcome): Record<string, unknown> {
  return {
    summaryCommentId: publication.summaryCommentId,
    publishedFileReviews: publication.publishedFileReviews,
    failedFileReviews: publication.failedFileReviews,
    failedInlineComments: publication.failedInlineComments,
    files: publication.files.map((file) => ({
      fileId: file.fileId,
      path: file.path,
      status: file.status,
      ...(file.reviewId !== undefined ? { reviewId: file.reviewId } : {}),
    })),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main().then((code) => {
    process.exit(code);
  });
}
