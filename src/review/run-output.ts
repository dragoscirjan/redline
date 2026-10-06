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
import type { FileReviewRecord, ReviewRunSummary } from './types.js';

export interface PublishedRun {
  readonly records: readonly FileReviewRecord[];
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
    if (!isRecord(value) || value['version'] !== 2) {
      throw new Error(`review output record ${file} is not a v2 record`);
    }
    records.push(value as unknown as FileReviewRecord);
  }
  const summaryValue = JSON.parse(await readFile(join(reviewsDirectory, 'summary.json'), 'utf8')) as unknown;
  if (!isRecord(summaryValue) || summaryValue['version'] !== 2) {
    throw new Error('review output summary is not a v2 summary');
  }
  return { records, summary: summaryValue as unknown as ReviewRunSummary };
}
