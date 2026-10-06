/**
 * Publication orchestration: turns written review records into GitHub
 * objects — one review per file with findings, plus the managed summary.
 *
 * The stale-head guard runs before anything is published; reviews bind to
 * the reviewed head through `commit_id`. Per-file failures never abort the
 * run: they are counted, reported in the summary, and returned to the
 * caller. Total failure (including a stale head) is the caller's signal
 * to fail loudly.
 */

import type { PublicationEnvironment } from '../review/environment.js';
import type { FileReviewRecord, ReviewRunSummary } from '../review/types.js';
import { GitHubReviewPublisher } from './github-publisher.js';
import {
  fileReviewMarker,
  renderFileReviewBody,
  renderFindingComment,
  renderSummaryBody,
  summaryMarker,
} from './render.js';
import type { FileReviewPublication, ReviewPublisher, ReviewScope } from './types.js';

export const MAX_PUBLISHED_FILE_REVIEWS = 25;
export const MAX_PUBLISHED_INLINE_COMMENTS = 100;

export interface PublicationFileResult {
  readonly fileId: string;
  readonly path: string;
  readonly status: 'published' | 'skipped' | 'failed';
  readonly reviewId?: number;
  readonly reason?: string;
  readonly publishedComments?: number;
}

export interface PublicationOutcome {
  readonly summaryCommentId: number;
  readonly files: readonly PublicationFileResult[];
  readonly publishedFileReviews: number;
  readonly failedFileReviews: number;
  readonly failedInlineComments: number;
}

export interface PublicationServiceOptions {
  /** Publisher override for tests; defaults to the configured publisher. */
  readonly publisher?: ReviewPublisher;
}

export class PublicationService {
  readonly #publisher: ReviewPublisher;
  readonly #scope: ReviewScope;

  constructor(publisher: ReviewPublisher, scope: ReviewScope) {
    this.#publisher = publisher;
    this.#scope = scope;
  }

  get scope(): ReviewScope {
    return this.#scope;
  }

  /** Builds one file review publication from a written record. */
  buildFilePublication(record: FileReviewRecord, commentBudget: number): FileReviewPublication | undefined {
    if (record.findings.length === 0) return undefined;
    const budget = Math.min(record.findings.length, commentBudget);
    return {
      fileId: record.fileId,
      path: record.path,
      body: renderFileReviewBody(this.#scope, record),
      marker: fileReviewMarker(this.#scope, record.fileId),
      comments: record.findings.slice(0, budget).map((finding) => ({
        path: record.path,
        side: finding.side,
        // The comment anchors the full finding span so an apply-able
        // suggestion replaces every span line, not just one.
        line: finding.endLine,
        ...(finding.startLine < finding.endLine
          ? { startLine: finding.startLine, startSide: finding.side }
          : {}),
        body: renderFindingComment(this.#scope, record.path, finding),
      })),
    };
  }

  async publish(records: readonly FileReviewRecord[], summary: ReviewRunSummary): Promise<PublicationOutcome> {
    // Stale guard: never publish reviews for a head the PR has moved past.
    const currentHead = await this.#publisher.currentHead(this.#scope);
    if (currentHead !== this.#scope.head) {
      throw new Error('pull request head changed during review');
    }

    const filesWithFindings = records.filter((record) => record.findings.length > 0);
    const results: PublicationFileResult[] = [];
    let publishedFileReviews = 0;
    let failedFileReviews = 0;
    let failedInlineComments = 0;
    let commentBudget = MAX_PUBLISHED_INLINE_COMMENTS;

    for (const record of filesWithFindings) {
      if (results.filter((item) => item.status === 'published').length >= MAX_PUBLISHED_FILE_REVIEWS) {
        results.push({
          fileId: record.fileId,
          path: record.path,
          status: 'skipped',
          reason: 'file review cap reached',
        });
        continue;
      }
      const publication = this.buildFilePublication(record, commentBudget);
      if (publication === undefined || publication.comments.length === 0) {
        results.push({
          fileId: record.fileId,
          path: record.path,
          status: 'skipped',
          reason: 'inline comment cap reached',
        });
        continue;
      }
      const omittedComments = record.findings.length - publication.comments.length;
      try {
        const reviewId = await this.#publisher.publishFileReview(this.#scope, publication);
        commentBudget -= publication.comments.length;
        publishedFileReviews += 1;
        results.push({
          fileId: record.fileId,
          path: record.path,
          status: 'published',
          reviewId,
          publishedComments: publication.comments.length,
        });
      } catch (error) {
        failedFileReviews += 1;
        failedInlineComments += omittedComments + publication.comments.length;
        results.push({
          fileId: record.fileId,
          path: record.path,
          status: 'failed',
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
      }
    }

    const notes = { publishedFileReviews, failedFileReviews, failedInlineComments };
    const summaryBody = renderSummaryBody(this.#scope, summary, notes);
    const summaryCommentId = await this.#publisher.upsertSummary(this.#scope, summaryBody, summaryMarker(this.#scope));

    return {
      summaryCommentId,
      files: results,
      publishedFileReviews,
      failedFileReviews,
      failedInlineComments,
    };
  }
}

export interface PublishRecordsInput {
  readonly records: readonly FileReviewRecord[];
  readonly summary: ReviewRunSummary;
  readonly publication: PublicationEnvironment;
  /** Publisher override for tests; defaults to the GitHub adapter. */
  readonly publisher?: ReviewPublisher;
}

/** Publishes written review records using the configured publication context. */
export async function publishRecords(input: PublishRecordsInput): Promise<PublicationOutcome> {
  const publisher =
    input.publisher ??
    new GitHubReviewPublisher({ token: input.publication.token });
  const service = new PublicationService(publisher, {
    repository: input.publication.repository,
    pullRequest: input.publication.pullRequest,
    head: input.publication.head,
  });
  return service.publish(input.records, input.summary);
}
