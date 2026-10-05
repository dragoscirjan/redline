/**
 * Review orchestration: loads the context bundle, prepares the harness
 * executor, runs one fixed prompt per reviewed file, validates each review
 * document against the authoritative diff, and persists per-file records
 * plus a run summary.
 *
 * A per-file failure never aborts the run: the file is recorded as omitted
 * with a bounded reason and the remaining files are still reviewed. The
 * run exits non-zero only when no reviewed file produced a validated
 * review (total harness or output failure) or when the bundle itself
 * cannot be loaded.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessExecutor } from '../harness-executor/registry.js';
import type { HarnessExecutor } from '../harness-executor/types.js';
import { loadReviewBundle, type ReviewBundle, type ReviewManifestFile } from './bundle.js';
import type { ReviewEnvironment } from './environment.js';
import { buildFileReviewPrompt } from './prompt.js';
import { FileReviewValidator, parseFileReviewDocument } from './report.js';
import type {
  FileReviewRecord,
  ReviewRunSummary,
  ReviewRunSummaryFile,
  ValidatedFinding,
} from './types.js';
import { createReviewWriter } from './writer.js';

const MAX_REASON_CHARS = 500;

export interface ReviewRunInput {
  readonly environment: ReviewEnvironment;
  /** Executor override for tests; defaults to the registry for the harness. */
  readonly executor?: HarnessExecutor;
}

export interface ReviewRunResult {
  readonly summary: ReviewRunSummary;
  readonly outputDirectory: string;
  readonly exitCode: number;
}

function boundedReason(value: string): string {
  const normalized = value.replaceAll('\n', ' ').trim();
  return normalized.length > MAX_REASON_CHARS ? `${normalized.slice(0, MAX_REASON_CHARS)}…` : normalized;
}

function fileReviewPath(file: ReviewManifestFile): string {
  return file.newPath ?? file.oldPath ?? file.id;
}

async function reviewOneFile(
  executor: HarnessExecutor,
  prepared: Awaited<ReturnType<HarnessExecutor['prepare']>>,
  environment: ReviewEnvironment,
  bundle: ReviewBundle,
  file: ReviewManifestFile,
): Promise<FileReviewRecord & { rawModelOutput?: string | undefined }> {
  const validator = new FileReviewValidator(
    file,
    await readFile(`${bundle.root}/${file.diffFile}`, 'utf8'),
    environment.findingScope,
  );
  const prompt = await buildFileReviewPrompt({
    bundle,
    file,
    findingScope: environment.findingScope,
    harness: environment.harness,
    model: environment.model.model,
  });
  const run = await executor.execute(prepared, prompt);

  if (run.status !== 'succeeded') {
    return {
      version: 1,
      fileId: file.id,
      path: fileReviewPath(file),
      status: file.status,
      harness: environment.harness,
      model: environment.model.model,
      outcome: 'omitted',
      errorKind: run.status === 'timed-out' ? 'harness-timeout' : 'harness-failed',
      reason: boundedReason(run.diagnostic || run.status),
      findings: [],
      durationMs: run.durationMs,
    };
  }

  let document;
  try {
    document = parseFileReviewDocument(run.text);
  } catch (error) {
    return {
      version: 1,
      fileId: file.id,
      path: fileReviewPath(file),
      status: file.status,
      harness: environment.harness,
      model: environment.model.model,
      outcome: 'omitted',
      errorKind: 'invalid-output',
      reason: boundedReason(error instanceof Error ? error.message : String(error)),
      findings: [],
      durationMs: run.durationMs,
      rawModelOutput: run.text,
    };
  }
  if (document.fileId !== file.id) {
    return {
      version: 1,
      fileId: file.id,
      path: fileReviewPath(file),
      status: file.status,
      harness: environment.harness,
      model: environment.model.model,
      outcome: 'omitted',
      errorKind: 'invalid-output',
      reason: `review document targets file ${document.fileId} instead of ${file.id}`,
      findings: [],
      durationMs: run.durationMs,
      rawModelOutput: run.text,
    };
  }

  let findings: readonly ValidatedFinding[];
  try {
    findings = validator.validateFindings(document.findings);
  } catch (error) {
    return {
      version: 1,
      fileId: file.id,
      path: fileReviewPath(file),
      status: file.status,
      harness: environment.harness,
      model: environment.model.model,
      outcome: 'omitted',
      errorKind: 'invalid-output',
      reason: boundedReason(error instanceof Error ? error.message : String(error)),
      findings: [],
      durationMs: run.durationMs,
      rawModelOutput: run.text,
    };
  }

  const outcome = document.outcome === 'omitted' ? 'omitted' : findings.length > 0 ? 'findings' : 'clean';
  return {
    version: 1,
    fileId: file.id,
    path: fileReviewPath(file),
    status: file.status,
    harness: environment.harness,
    model: environment.model.model,
    outcome,
    reason: document.reason !== undefined ? boundedReason(document.reason) : undefined,
    findings,
    durationMs: run.durationMs,
    rawModelOutput: run.text,
  };
}

/**
 * Runs per-file reviews for the whole bundle and writes all outputs.
 */
export async function runFileReviews(input: ReviewRunInput): Promise<ReviewRunResult> {
  const { environment } = input;
  const bundle = await loadReviewBundle(environment.reviewDirectory, environment.sourceDirectory);
  const writer = createReviewWriter(environment.outputDirectory);
  const executor = input.executor ?? createHarnessExecutor(environment.harness);

  const workDirectory = await mkdtemp(join(tmpdir(), 'redline-review-'));
  try {
    const prepared = await executor.prepare({
      model: environment.model,
      credential: environment.credential,
      timeoutMs: environment.timeout.milliseconds,
      workDirectory,
    });

    const records: (FileReviewRecord & { rawModelOutput?: string | undefined })[] = [];
    for (const file of bundle.manifest.files) {
      if (!file.reviewed) continue;
      if (file.binary) {
        const binaryRecord: FileReviewRecord & { rawModelOutput?: string | undefined } = {
          version: 1,
          fileId: file.id,
          path: fileReviewPath(file),
          status: file.status,
          harness: environment.harness,
          model: environment.model.model,
          outcome: 'omitted',
          reason: 'binary diff; not reviewable as text',
          findings: [],
          durationMs: 0,
        };
        records.push(binaryRecord);
        await writer.writeFileReview(binaryRecord);
        continue;
      }
      const record = await reviewOneFile(executor, prepared, environment, bundle, file);
      records.push(record);
      await writer.writeFileReview(record);
    }

    const summary: ReviewRunSummary = {
      version: 1,
      harness: environment.harness,
      model: environment.model.model,
      provider: environment.model.provider,
      findingScope: environment.findingScope,
      base: bundle.manifest.base,
      head: bundle.manifest.head,
      manifestFiles: bundle.manifest.files.length,
      reviewedFiles: records.length,
      omittedFiles: records.filter((record) => record.outcome === 'omitted').length,
      findings: records.reduce((total, record) => total + record.findings.length, 0),
      files: records.map((record): ReviewRunSummaryFile => ({
        fileId: record.fileId,
        path: record.path,
        outcome: record.outcome,
        errorKind: record.errorKind,
        findingCount: record.findings.length,
      })),
    };
    await writer.writeSummary(summary);

    const validatedReviews = records.filter(
      (record) => record.outcome === 'clean' || record.outcome === 'findings',
    ).length;
    return {
      summary,
      outputDirectory: environment.outputDirectory,
      exitCode: validatedReviews > 0 || records.length === 0 ? 0 : 1,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}
