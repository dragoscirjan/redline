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
import type { HarnessOutputLine } from '../harness-executor/types.js';
import type { ReviewVerbosity } from './environment.js';
import {
  GitHubReviewPublisher,
  PublicationService,
  type PublicationOutcome,
  type RunningSummaryInfo,
} from '../publish/index.js';
import type { ReviewPublisher } from '../publish/index.js';
import type { FileReviewRecord } from './types.js';
import { parseReviewEnvironment } from './environment.js';
import { runFileReviews, type ReviewRunInput } from './runner.js';

const USAGE_ERROR_EXIT = 2;
const RUN_FAILURE_EXIT = 1;

function writeLine(stream: NodeJS.WriteStream, value: string): void {
  stream.write(`${value}\n`);
}

/** One bounded stderr line per completed file: live progress in the run log. */
function progressLine(record: FileReviewRecord): void {
  const error = record.errorKind !== undefined ? ` (${record.errorKind})` : '';
  writeLine(process.stderr, `redline-review: ${record.path}: ${record.outcome}${error}`);
}

/** Marks the start of a file's review in the run log. */
function fileStartLine(file: { readonly path: string }): void {
  writeLine(process.stderr, `redline-review: reviewing ${file.path}…`);
}

/**
 * Maps the verbosity level to the runner's progress callbacks. Per-file
 * start/done lines are always present — they are the minimal signal that
 * a long sequential run is alive; the level controls only the live model
 * stream.
 */
function progressCallbacks(verbosity: ReviewVerbosity): {
  onFileStart: typeof fileStartLine;
  onFileDone: typeof progressLine;
  onHarnessOutput?: ReviewRunInput['onHarnessOutput'];
  harnessStreamMode?: 'dots' | 'text';
} {
  if (verbosity === 'silent') {
    return { onFileStart: fileStartLine, onFileDone: progressLine };
  }
  return {
    onFileStart: fileStartLine,
    onFileDone: progressLine,
    onHarnessOutput: harnessLine,
    harnessStreamMode: verbosity === 'progress' ? 'dots' : 'text',
  };
}

/** Bounded live harness output on stderr. */
function harnessLine(output: HarnessOutputLine): void {
  if (output.kind === 'text') {
    // Raw fragments of the model's streaming text; written unprefixed so
    // consecutive fragments read as continuous output. Already redacted
    // and sanitized by the harness layer.
    process.stderr.write(output.line);
    return;
  }
  writeLine(process.stderr, `redline-review: harness ${output.stream}: ${output.line.slice(0, 200)}`);
}

export interface CliDependencies {
  /** Publisher override for tests; defaults to the GitHub adapter. */
  readonly publisher?: ReviewPublisher;
}

export async function main(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const validateOnly = arguments_.includes('--validate-only');
  if (arguments_.some((argument) => argument !== '--validate-only')) {
    writeLine(process.stderr, 'redline-review: unsupported argument (only --validate-only is accepted)');
    return USAGE_ERROR_EXIT;
  }

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
            }
          : { mode: 'context-only', timeoutMinutes: parsed.timeout.minutes },
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
        result = await runFileReviews({ ...progressCallbacks(parsed.verbosity), environment: review });
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
        const publication = await service.publish(result.records, result.summary);
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

    const result = await runFileReviews({ ...progressCallbacks(parsed.verbosity), environment: review });
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
