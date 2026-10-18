/**
 * Loads a completed review run's output from disk.
 *
 * `--publish-only` re-reads what the review run wrote — the per-file JSON
 * records and the run summary — so publication can run in its own process
 * with a freshly minted token after any review duration.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './bundle.js';
import {
  FILE_REVIEW_RECORD_VERSION,
  PULL_REQUEST_REVIEW_VERSION,
  REVIEW_RUN_SUMMARY_VERSION,
  type FileReviewRecord,
  type PullRequestReviewRecord,
  type ReviewRunSummary,
} from './types.js';

export interface PublishedRun {
  readonly records: readonly FileReviewRecord[];
  readonly review: PullRequestReviewRecord;
  readonly summary: ReviewRunSummary;
}

const RECORD_FILE_PATTERN = /^[0-9]{6}\.json$/u;

export async function loadPublishedRun(outputDirectory: string): Promise<PublishedRun> {
  const reviewsDirectory = join(outputDirectory, 'reviews');
  let entries: string[];
  try {
    entries = await readdir(reviewsDirectory);
  } catch {
    throw new Error(`review output directory is missing: ${reviewsDirectory}`);
  }
  const recordFiles = entries.filter((entry) => RECORD_FILE_PATTERN.test(entry)).sort();
  if (recordFiles.length === 0) {
    throw new Error(`review output contains no per-file records: ${reviewsDirectory}`);
  }
  const records: FileReviewRecord[] = [];
  for (const file of recordFiles) {
    const value = JSON.parse(await readFile(join(reviewsDirectory, file), 'utf8')) as unknown;
    if (!isRecord(value) || value['version'] !== FILE_REVIEW_RECORD_VERSION) {
      throw new Error(`review output record ${file} is not a v${FILE_REVIEW_RECORD_VERSION} record`);
    }
    records.push(value as unknown as FileReviewRecord);
  }
  const summaryValue = JSON.parse(await readFile(join(reviewsDirectory, 'summary.json'), 'utf8')) as unknown;
  if (!isRecord(summaryValue) || summaryValue['version'] !== REVIEW_RUN_SUMMARY_VERSION) {
    throw new Error(`review output summary is not a v${REVIEW_RUN_SUMMARY_VERSION} summary`);
  }
  const reviewValue = JSON.parse(await readFile(join(reviewsDirectory, 'review.json'), 'utf8')) as unknown;
  if (!isRecord(reviewValue) || (reviewValue['version'] !== 1 && reviewValue['version'] !== PULL_REQUEST_REVIEW_VERSION)) {
    throw new Error(`review output PR record is not a supported v1/v${PULL_REQUEST_REVIEW_VERSION} record`);
  }
  // v1 had no synthesis plan. Reject any evidence of verification before
  // migrating non-verified records; rewriting the version first would erase
  // the only explicit legacy discriminator at publication time.
  if (reviewValue['version'] === 1 && (
    reviewValue['synthesis'] !== undefined
    || (isRecord(reviewValue['coverage']) && reviewValue['coverage']['verification'] !== undefined
      && (!isRecord(reviewValue['coverage']['verification'])
        || reviewValue['coverage']['verification']['status'] !== 'not-applicable'
        || reviewValue['coverage']['verification']['required'] !== false))
    || records.some((record) => record.verification !== undefined
      || record.findings.some((finding) => finding.verification?.status !== 'unverified'))
  )) {
    throw new Error('verified legacy v1 review cannot be published without a deterministic publication plan');
  }
  const review = reviewValue['version'] === 1
    ? { ...reviewValue, version: PULL_REQUEST_REVIEW_VERSION }
    : reviewValue;
  return {
    records,
    review: review as unknown as PullRequestReviewRecord,
    summary: summaryValue as unknown as ReviewRunSummary,
  };
}
