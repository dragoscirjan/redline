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
import { buildFileReviewPrompt, type FileReviewPrompt } from './prompt.js';
import { FileReviewValidator, parseFileReviewDocument } from './report.js';
import { buildRemediation, formatSpan } from './remediation.js';
import type {
  FileReviewRecord,
  PublishedFinding,
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

/**
 * Removes every occurrence of the selected credential from a value that is
 * about to be persisted. A failing harness child can echo the credential it
 * was given into its diagnostics; persisted reasons and raw model output
 * must never carry it.
 */
function redactCredential(value: string, credential: ReviewEnvironment['credential']): string {
  if (credential === undefined || credential.value.length === 0) return value;
  return value.split(credential.value).join('[redacted]');
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
  const redact = (value: string): string => redactCredential(value, environment.credential);
  const described = {
    version: 2 as const,
    fileId: file.id,
    path: fileReviewPath(file),
    status: file.status,
    harness: environment.harness,
    model: environment.model.model,
  };

  // Preparation (diff reading, validator construction, prompt assembly) is
  // per-file work: its failures produce an omitted record, never an abort.
  let validator: FileReviewValidator;
  let prompt: FileReviewPrompt;
  try {
    validator = new FileReviewValidator(
      file,
      await readFile(`${bundle.root}/${file.diffFile}`, 'utf8'),
      environment.findingScope,
    );
    prompt = await buildFileReviewPrompt({
      bundle,
      file,
      findingScope: environment.findingScope,
      harness: environment.harness,
      model: environment.model.model,
    });
  } catch (error) {
    return {
      ...described,
      outcome: 'omitted',
      errorKind: 'preparation-failed',
      reason: boundedReason(redact(error instanceof Error ? error.message : String(error))),
      findings: [],
      durationMs: 0,
    };
  }

  const run = await executor.execute(prepared, prompt);

  if (run.status !== 'succeeded') {
    return {
      ...described,
      outcome: 'omitted',
      errorKind: run.status === 'timed-out' ? 'harness-timeout' : 'harness-failed',
      reason: boundedReason(redact(run.diagnostic) || run.status),
      findings: [],
      durationMs: run.durationMs,
    };
  }

  let document;
  try {
    document = parseFileReviewDocument(run.text);
  } catch (error) {
    return {
      ...described,
      outcome: 'omitted',
      errorKind: 'invalid-output',
      reason: boundedReason(redact(error instanceof Error ? error.message : String(error))),
      findings: [],
      durationMs: run.durationMs,
      rawModelOutput: redact(run.text),
    };
  }
  if (document.fileId !== file.id) {
    return {
      ...described,
      outcome: 'omitted',
      errorKind: 'invalid-output',
      reason: boundedReason(
        redact(`review document targets file ${document.fileId} instead of ${file.id}`),
      ),
      findings: [],
      durationMs: run.durationMs,
      rawModelOutput: redact(run.text),
    };
  }

  let findings: readonly ValidatedFinding[];
  try {
    findings = validator.validateFindings(document.findings);
  } catch (error) {
    return {
      ...described,
      outcome: 'omitted',
      errorKind: 'invalid-output',
      reason: boundedReason(redact(error instanceof Error ? error.message : String(error))),
      findings: [],
      durationMs: run.durationMs,
      rawModelOutput: redact(run.text),
    };
  }

  // Each validated finding is enriched for publication: the rendered
  // change suggestion (when resolvable) and the fix prompt. Both embed
  // model-derived text, so both are redacted against the credential.
  const published: PublishedFinding[] = [];
  for (const finding of findings) {
    const remediation = await buildRemediation(bundle, file, finding, validator.changed);
    const { suggestedChange: _modelProposal, ...core } = finding;
    published.push({
      ...core,
      ...(remediation.suggestion !== undefined
        ? { suggestion: redact(remediation.suggestion) }
        : {}),
      fixPrompt: redact(remediation.fixPrompt),
    });
  }

  const outcome = document.outcome === 'omitted' ? 'omitted' : published.length > 0 ? 'findings' : 'clean';
  return {
    ...described,
    outcome,
    reason: document.reason !== undefined ? boundedReason(redact(document.reason)) : undefined,
    findings: published,
    durationMs: run.durationMs,
    rawModelOutput: redact(run.text),
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
          version: 2,
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
      version: 2,
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
        findingSpans: record.findings.map((finding) => formatSpan(finding.startLine, finding.endLine)),
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
