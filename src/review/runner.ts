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
import type { HarnessExecutor, HarnessOutputLine, HarnessStreamMode } from '../harness-executor/types.js';
import { loadReviewBundle, type ReviewBundle, type ReviewManifestFile } from './bundle.js';
import type { ReviewEnvironment } from './environment.js';
import {
  codeContextForFile,
  loadReviewCodeContext,
  type LoadedReviewCodeContext,
} from './indexed-context.js';
import { buildFileReviewPrompt, type FileReviewPrompt } from './prompt.js';
import { buildPullRequestReview, validateFindingReferences } from './pr-contract.js';
import { FileReviewValidator, parseFileReviewDocument } from './report.js';
import { buildRemediation, formatSpan } from './remediation.js';
import { parseVerificationDocument, validateVerificationDocument } from './verification.js';
import { buildVerificationPrompt } from './verification-prompt.js';
import {
  FILE_REVIEW_RECORD_VERSION,
  REVIEW_RUN_SUMMARY_VERSION,
  type FileReviewRecord,
  type FileVerificationCoverage,
  type PublishedFinding,
  type PullRequestReviewRecord,
  type RejectedCandidate,
  type ReviewRunSummary,
  type ReviewRunSummaryFile,
  type ValidatedFinding,
} from './types.js';
import { createReviewWriter, type VerificationArtifact } from './writer.js';

const MAX_REASON_CHARS = 500;
export const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1_000;

export interface ReviewRunInput {
  readonly environment: ReviewEnvironment;
  /** Executor override for tests; defaults to the registry for the harness. */
  readonly executor?: HarnessExecutor | undefined;
  /** Enables the fail-closed verifier during benchmark evaluation before publication rollout. */
  readonly verifyCandidates?: boolean | undefined;
  /**
   * Called after each reviewed file completes, for live progress in the
   * run log — a long sequential run must stay distinguishable from a
   * hang. Absent in tests unless they assert progress.
   */
  readonly onFileDone?: ((record: FileReviewRecord) => void) | undefined;
  /**
   * Called before a file's prompt runs; pairs with `onFileDone` for the
   * per-file progress narrative in the run log.
   */
  readonly onFileStart?: ((record: { readonly path: string }) => void) | undefined;
  /**
   * Live harness output tap while a file's prompt runs. Harnesses forward
   * bounded heartbeat lines and readable text fragments (redacted and
   * capped), never unbounded raw output.
   */
  readonly onHarnessOutput?: ((output: HarnessOutputLine) => void) | undefined;
  /** Stream presentation for the tap; defaults to the harness's own. */
  readonly harnessStreamMode?: HarnessStreamMode | undefined;
}

export interface ReviewRunResult {
  readonly review: PullRequestReviewRecord;
  readonly summary: ReviewRunSummary;
  /** The per-file records as written, consumed by the publication layer. */
  readonly records: readonly FileReviewRecord[];
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
  indexedContext: LoadedReviewCodeContext,
  file: ReviewManifestFile,
  onHarnessOutput?: (output: HarnessOutputLine) => void,
  harnessStreamMode?: HarnessStreamMode,
  verifyCandidates = false,
): Promise<FileReviewRecord & { rawModelOutput?: string | undefined; verificationArtifact?: VerificationArtifact | undefined }> {
  const redact = (value: string): string => redactCredential(value, environment.credential);
  const fileContext = codeContextForFile(indexedContext, file);
  const described = {
    version: FILE_REVIEW_RECORD_VERSION,
    fileId: file.id,
    path: fileReviewPath(file),
    status: file.status,
    harness: environment.harness,
    model: environment.model.model,
    codeContext: fileContext.coverage,
    ...(verifyCandidates ? {
      verification: {
        status: 'incomplete' as const,
        requested: 0,
        accepted: 0,
        rejected: 0,
        durationMs: 0,
        reason: 'discovery did not complete',
      },
    } : {}),
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
      indexedContext: fileContext.prompt,
    });
  } catch (error) {
    return {
      ...described,
      outcome: 'omitted',
      errorKind: 'preparation-failed',
      reason: boundedReason(redact(error instanceof Error ? error.message : String(error))),
      findings: [],
      rejectedCandidates: [],
      durationMs: 0,
    };
  }

  const run = await executor.execute(
    prepared,
    prompt,
    onHarnessOutput === undefined
      ? undefined
      : {
          onOutputLine: onHarnessOutput,
          ...(harnessStreamMode !== undefined ? { streamMode: harnessStreamMode } : {}),
        },
  );

  if (run.status !== 'succeeded') {
    return {
      ...described,
      outcome: 'omitted',
      errorKind: run.status === 'timed-out' ? 'harness-timeout' : 'harness-failed',
      reason: boundedReason(redact(run.diagnostic) || run.status),
      findings: [],
      rejectedCandidates: [],
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
      rejectedCandidates: [],
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
      rejectedCandidates: [],
      durationMs: run.durationMs,
      rawModelOutput: redact(run.text),
    };
  }

  const triggerValidation = validator.validateCandidates(document.findings, document.candidateIndices);
  const sanitizeRejection = (candidate: RejectedCandidate): RejectedCandidate => ({
    ...candidate,
    reason: boundedReason(redact(candidate.reason)),
  });
  const rejectedCandidates: RejectedCandidate[] = [
    ...document.rejectedCandidates,
    ...triggerValidation.rejectedCandidates,
  ].map(sanitizeRejection);
  const findings: ValidatedFinding[] = [];
  const candidateIndexes = new Map<string, number>();
  for (const [position, finding] of triggerValidation.findings.entries()) {
    const index = triggerValidation.candidateIndices[position] as number;
    try {
      findings.push(await validateFindingReferences(bundle, finding, indexedContext));
      candidateIndexes.set(finding.id, index);
    } catch (error) {
      rejectedCandidates.push({
        index,
        stage: 'validation',
        code: 'candidate-support-invalid',
        reason: boundedReason(redact(error instanceof Error ? error.message : String(error))),
      });
    }
  }

  let verifiedFindings = findings;
  let verification: FileVerificationCoverage | undefined;
  let verificationArtifact: VerificationArtifact | undefined;
  let verificationDurationMs = 0;
  if (verifyCandidates && document.outcome === 'omitted') {
    return {
      ...described,
      outcome: 'omitted',
      reason: boundedReason(redact(document.reason ?? 'discovery omitted the file')),
      findings: [],
      rejectedCandidates,
      durationMs: run.durationMs,
      rawModelOutput: redact(run.text),
    };
  }
  if (verifyCandidates && findings.length === 0) {
    verification = {
      status: 'not-applicable', requested: 0, accepted: 0, rejected: 0, durationMs: 0,
    };
  }
  if (verifyCandidates && findings.length > 0) {
    let verifierOutput = '';
    try {
      const verifierPrompt = await buildVerificationPrompt({
        bundle,
        file,
        candidates: findings,
        findingScope: environment.findingScope,
        harness: environment.harness,
        model: environment.model.model,
        indexedContext: fileContext.prompt,
      });
      const verifiedRun = await executor.execute(prepared, verifierPrompt, {
        timeoutMs: VERIFICATION_TIMEOUT_MS,
        ...(onHarnessOutput === undefined ? {} : { onOutputLine: onHarnessOutput }),
        ...(harnessStreamMode === undefined ? {} : { streamMode: harnessStreamMode }),
      });
      verificationDurationMs = verifiedRun.durationMs;
      verifierOutput = redact(verifiedRun.text);
      if (verifiedRun.status !== 'succeeded') {
        throw new Error(`verifier ${verifiedRun.status}: ${redact(verifiedRun.diagnostic)}`);
      }
      const verificationDocument = parseVerificationDocument(verifiedRun.text, file.id, findings);
      const dispositions = await validateVerificationDocument(
        bundle, file, findings, verificationDocument, environment.findingScope,
      );
      verifiedFindings = dispositions.flatMap((item) => item.finding === undefined ? [] : [{
        ...item.finding,
        verification: {
          status: 'confirmed' as const,
          reason: boundedReason(redact(item.finding.verification.reason)),
        },
      }]);
      for (const item of dispositions) {
        if (item.finding !== undefined) continue;
        rejectedCandidates.push({
          index: candidateIndexes.get(item.candidateId) as number,
          stage: 'verification',
          code: `verification-${item.disposition}`,
          reason: boundedReason(redact(item.reason)),
        });
      }
      const inconclusive = dispositions.filter((item) => item.disposition === 'inconclusive').length;
      verification = {
        status: inconclusive === 0 ? 'completed' : 'incomplete',
        requested: findings.length,
        accepted: verifiedFindings.length,
        rejected: findings.length - verifiedFindings.length,
        durationMs: verificationDurationMs,
        ...(inconclusive === 0 ? {} : { reason: `${inconclusive} candidates lacked conclusive source-backed verification` }),
      };
      verificationArtifact = {
        version: 1,
        candidateIds: findings.map((item) => item.id),
        status: verification.status === 'completed' ? 'completed' : 'incomplete',
        dispositions: dispositions.map((item) => ({
          candidateId: item.candidateId,
          disposition: item.disposition,
          reason: boundedReason(redact(item.reason)),
        })),
        rawModelOutput: verifierOutput,
      };
    } catch (error) {
      const reason = boundedReason(redact(error instanceof Error ? error.message : String(error)));
      verification = {
        status: 'incomplete',
        requested: findings.length,
        accepted: 0,
        rejected: findings.length,
        durationMs: verificationDurationMs,
        reason,
      };
      verificationArtifact = {
        version: 1,
        candidateIds: findings.map((item) => item.id),
        status: 'incomplete',
        dispositions: findings.map((item) => ({ candidateId: item.id, disposition: 'inconclusive', reason })),
        rawModelOutput: verifierOutput,
      };
      for (const item of findings) {
        rejectedCandidates.push({
          index: candidateIndexes.get(item.id) as number,
          stage: 'verification',
          code: 'verification-failed',
          reason,
        });
      }
      return {
        ...described,
        verification,
        verificationArtifact,
        outcome: 'omitted',
        errorKind: 'verification-failed',
        reason,
        findings: [],
        rejectedCandidates,
        durationMs: run.durationMs + verificationDurationMs,
        rawModelOutput: redact(run.text),
      };
    }
  }

  // Each validated finding is enriched for publication: the rendered
  // change suggestion (when resolvable) and the fix prompt. Both embed
  // model-derived text, so both are redacted against the credential.
  const published: PublishedFinding[] = [];
  for (const finding of verifiedFindings) {
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

  const invalidCandidates = rejectedCandidates.filter((candidate) =>
    candidate.stage !== 'verification' ||
    (candidate.code !== 'verification-rejected' && candidate.code !== 'verification-duplicate'));
  const allCandidatesInvalid = published.length === 0 && invalidCandidates.length > 0;
  const outcome = document.outcome === 'omitted' || allCandidatesInvalid
    ? 'omitted'
    : published.length > 0
      ? 'findings'
      : 'clean';
  return {
    ...described,
    outcome,
    ...(allCandidatesInvalid ? {
      errorKind: invalidCandidates.some((candidate) => candidate.code === 'verification-inconclusive')
        ? 'verification-failed' as const
        : 'invalid-output' as const,
    } : {}),
    reason: allCandidatesInvalid
      ? `${invalidCandidates.length} review candidates failed required validation or verification`
      : verifyCandidates && published.length === 0 && rejectedCandidates.length > 0
        ? 'Discovery candidates were disproved by the verifier.'
        : document.reason !== undefined
          ? boundedReason(redact(document.reason))
          : undefined,
    findings: published,
    rejectedCandidates,
    ...(verification === undefined ? {} : { verification }),
    ...(verificationArtifact === undefined ? {} : { verificationArtifact }),
    durationMs: run.durationMs + verificationDurationMs,
    rawModelOutput: redact(run.text),
  };
}

/**
 * Runs per-file reviews for the whole bundle and writes all outputs.
 */
export async function runFileReviews(input: ReviewRunInput): Promise<ReviewRunResult> {
  const { environment } = input;
  const bundle = await loadReviewBundle(environment.reviewDirectory, environment.sourceDirectory);
  const indexedContext = await loadReviewCodeContext(bundle, environment.codeContext);
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

    const records: (FileReviewRecord & {
      rawModelOutput?: string | undefined;
      verificationArtifact?: VerificationArtifact | undefined;
    })[] = [];
    for (const file of bundle.manifest.files) {
      if (!file.reviewed) continue;
      if (file.binary) {
        const binaryRecord: FileReviewRecord & { rawModelOutput?: string | undefined } = {
          version: FILE_REVIEW_RECORD_VERSION,
          fileId: file.id,
          path: fileReviewPath(file),
          status: file.status,
          harness: environment.harness,
          model: environment.model.model,
          codeContext: codeContextForFile(indexedContext, file).coverage,
          outcome: 'omitted',
          reason: 'binary diff; not reviewable as text',
          findings: [],
          rejectedCandidates: [],
          durationMs: 0,
        };
        records.push(binaryRecord);
        await writer.writeFileReview(binaryRecord);
        input.onFileDone?.(binaryRecord);
        continue;
      }
      input.onFileStart?.({ path: fileReviewPath(file) });
      const record = await reviewOneFile(
        executor,
        prepared,
        environment,
        bundle,
        indexedContext,
        file,
        input.onHarnessOutput,
        input.harnessStreamMode,
        input.verifyCandidates,
      );
      records.push(record);
      await writer.writeFileReview(record);
      input.onFileDone?.(record);
    }

    const summary: ReviewRunSummary = {
      version: REVIEW_RUN_SUMMARY_VERSION,
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
      codeContext: indexedContext.coverage,
      files: records.map((record): ReviewRunSummaryFile => ({
        fileId: record.fileId,
        path: record.path,
        outcome: record.outcome,
        errorKind: record.errorKind,
        codeContext: record.codeContext,
        findingCount: record.findings.length,
        findingSpans: record.findings.map((finding) => formatSpan(finding.startLine, finding.endLine)),
      })),
    };
    await writer.writeSummary(summary);
    const review = buildPullRequestReview({ bundle, environment, records, indexedContext });
    await writer.writePullRequestReview(review);

    const validatedReviews = records.filter(
      (record) => record.outcome === 'clean' || record.outcome === 'findings',
    ).length;
    return {
      review,
      summary,
      records,
      outputDirectory: environment.outputDirectory,
      exitCode: validatedReviews > 0 || records.length === 0 ? 0 : 1,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}
