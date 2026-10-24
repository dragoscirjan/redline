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

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessExecutor } from '../harness-executor/registry.js';
import { FollowUpBudget, type FollowUpRequestBatch } from '../code-context/follow-up.js';
import type { HarnessExecutor, HarnessOutputLine, HarnessStreamMode } from '../harness-executor/types.js';
import { loadReviewBundle, type ReviewBundle, type ReviewManifestFile } from './bundle.js';
import type { ReviewEnvironment } from './environment.js';
import { followUpSourcesByCandidate, resolveFollowUpResults, type ResolvedFollowUp } from './follow-up.js';
import {
  codeContextForFile,
  loadReviewCodeContext,
  type LoadedReviewCodeContext,
} from './indexed-context.js';
import { buildFileReviewPrompt, type FileReviewPrompt } from './prompt.js';
import { buildPullRequestReview, validateFindingReferences } from './pr-contract.js';
import { FileReviewValidator, parseFileReviewDocument } from './report.js';
import { buildRemediation, formatSpan } from './remediation.js';
import {
  buildReviewSemanticFingerprint,
  loadReviewReuseCache,
  restoreReusableFileReview,
  REVIEW_REUSE_TELEMETRY_VERSION,
} from './reuse.js';
import { parseVerificationDocument, validateVerificationDocument } from './verification.js';
import { buildVerificationPrompt } from './verification-prompt.js';
import {
  FILE_REVIEW_RECORD_VERSION,
  MAX_REVIEW_REASON_CHARS,
  REVIEW_RUN_SUMMARY_VERSION,
  type FileReviewRecord,
  type FileFollowUpCoverage,
  type FileVerificationCoverage,
  type PublishedFinding,
  type PullRequestReviewRecord,
  type RejectedCandidate,
  type ReviewRunSummary,
  type ReviewRunSummaryFile,
  type ValidatedFinding,
} from './types.js';
import { createReviewWriter, type FollowUpArtifact, type VerificationArtifact } from './writer.js';

export const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1_000;

export interface FileReviewIdentity {
  readonly fileId: string;
  readonly path: string;
}

export interface FileReviewValidationEvent extends FileReviewIdentity {
  readonly outcome: FileReviewRecord['outcome'];
  readonly durationMs: number;
  readonly findingCount: number;
  readonly rejectedCandidateCount: number;
}

export interface FileHarnessOutputEvent extends HarnessOutputLine, FileReviewIdentity {}

export interface ReviewRunInput {
  readonly environment: ReviewEnvironment;
  /** Executor override for tests; defaults to the registry for the harness. */
  readonly executor?: HarnessExecutor | undefined;
  /** Enables the fail-closed verifier during benchmark evaluation before publication rollout. */
  readonly verifyCandidates?: boolean | undefined;
  /** Action-owned bounded provider resolver; review code never opens a provider database. */
  readonly followUpExecutor?: ((requests: FollowUpRequestBatch, remainingMs: number) => Promise<string>) | undefined;
  /**
   * Called after each reviewed file completes, for live progress in the
   * run log — a bounded parallel run must stay distinguishable from a
   * hang. Absent in tests unless they assert progress.
   */
  readonly onFileDone?: ((record: FileReviewRecord) => void) | undefined;
  /**
   * Called before a file's prompt runs; pairs with `onFileDone` for the
   * per-file progress narrative in the run log.
   */
  readonly onFileStart?: ((record: FileReviewIdentity) => void) | undefined;
  /**
   * Called after model output and review validation complete, immediately
   * before the per-file record is written. The bounded projection excludes
   * prompts, raw model output, diagnostics, and verification artifacts.
   */
  readonly onFileValidated?: ((event: FileReviewValidationEvent) => void) | undefined;
  /**
   * Live harness output tap while a file's prompt runs. Harnesses forward
   * bounded heartbeat lines and readable text fragments (redacted and
   * capped), never unbounded raw output.
   */
  readonly onHarnessOutput?: ((output: FileHarnessOutputEvent) => void) | undefined;
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
  return normalized.length > MAX_REVIEW_REASON_CHARS
    ? `${normalized.slice(0, MAX_REVIEW_REASON_CHARS)}…`
    : normalized;
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
  followUpBudget: FollowUpBudget,
  followUpExecutor?: (requests: FollowUpRequestBatch, remainingMs: number) => Promise<string>,
  onHarnessOutput?: (output: HarnessOutputLine) => void,
  harnessStreamMode?: HarnessStreamMode,
  verifyCandidates = false,
): Promise<FileReviewRecord & {
  rawModelOutput?: string | undefined;
  verificationArtifact?: VerificationArtifact | undefined;
  followUpArtifact?: FollowUpArtifact | undefined;
}> {
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
    execution: 'executed' as const,
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
      followUpAvailable: verifyCandidates && environment.codeContext !== undefined
        && followUpExecutor !== undefined && fileContext.coverage.provider !== null,
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

  const run = await executor.execute(prepared, prompt, {
    invocation: { fileId: file.id, path: fileReviewPath(file) },
    ...(onHarnessOutput === undefined ? {} : { onOutputLine: onHarnessOutput }),
    ...(harnessStreamMode === undefined ? {} : { streamMode: harnessStreamMode }),
  });

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

  let followUp: FileFollowUpCoverage | undefined;
  let followUpArtifact: FollowUpArtifact | undefined;
  let followUpResults: readonly ResolvedFollowUp[] = [];
  if (document.contextRequests.length > 0) {
    let requests: FollowUpRequestBatch | null = null;
    let omitted = 0;
    let requested = new Set(document.contextRequests.map((item) =>
      `${item.candidateIndex}:${item.direction}`)).size;
    let completed = 0;
    let durationMs = 0;
    let executorStartedAt: number | undefined;
    let reason: string | undefined;
    try {
      const seenIntents = new Set<string>();
      const intents = document.contextRequests.flatMap((request) => {
        const key = `${request.candidateIndex}:${request.direction}`;
        if (seenIntents.has(key)) return [];
        seenIntents.add(key);
        const candidate = findings.find((item) => candidateIndexes.get(item.id) === request.candidateIndex);
        if (candidate === undefined) {
          omitted += 1;
          return [];
        }
        return [{ candidateId: candidate.id, direction: request.direction }];
      });
      if (document.outcome === 'omitted' || !verifyCandidates) {
        throw new Error('follow-up is unavailable because independent verification did not run');
      }
      if (environment.codeContext === undefined) throw new Error('follow-up provider is not configured');
      requests = followUpBudget.plan({
        repository: environment.codeContext.repository,
        base: bundle.manifest.base,
        head: bundle.manifest.head,
      }, file.id, fileReviewPath(file), findings.map((item) => item.id), intents);
      omitted += requests.omitted;
      requested = requests.requests.length + omitted;
      if (requests.requests.length > 0) {
        const provider = indexedContext.coverage.provider;
        const startedAt = Date.now();
        if (provider !== null && followUpExecutor !== undefined) executorStartedAt = startedAt;
        const raw = provider !== null && followUpExecutor !== undefined
          ? await followUpExecutor(requests, followUpBudget.remainingTimeMs())
          : JSON.stringify({
            version: 1,
            repository: requests.repository,
            base: requests.base,
            head: requests.head,
            provider,
            snapshot: provider === null ? null : requests.base,
            results: requests.requests.map((request) => ({
              requestId: request.id, status: 'unavailable', reason: 'not-configured', durationMs: 0, spans: [],
            })),
          });
        const resolved = await resolveFollowUpResults(bundle, requests, raw, provider);
        const elapsed = executorStartedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
        followUpBudget.consume(raw, resolved, elapsed);
        followUpResults = resolved;
        completed = followUpResults.filter((item) => item.status === 'complete').length;
        durationMs = Math.max(elapsed, followUpResults.reduce((total, item) => total + item.durationMs, 0));
        if (completed !== requests.requests.length) {
          reason = `${requests.requests.length - completed} action-owned follow-up requests were unavailable or unconfirmed`;
        }
      }
    } catch (error) {
      if (executorStartedAt !== undefined) {
        durationMs = Math.max(0, Date.now() - executorStartedAt);
        followUpBudget.spendFailure(durationMs);
      }
      reason = boundedReason(redact(error instanceof Error ? error.message : String(error)));
    }
    if (omitted > 0) reason = reason ?? `${omitted} follow-up requests exceeded budgets or lacked validated candidates`;
    followUp = {
      status: completed === requested && omitted === 0 ? 'completed' : 'incomplete',
      requested, completed, omitted, durationMs,
      ...(reason === undefined ? {} : { reason }),
    };
    const artifact: FollowUpArtifact = {
      version: 1, requests, results: followUpResults,
      ...(followUp.reason === undefined ? {} : { reason: followUp.reason }),
    };
    followUpArtifact = JSON.parse(JSON.stringify(artifact, (_key, value: unknown) =>
      typeof value === 'string' ? redact(value) : value)) as FollowUpArtifact;
  }

  if (!verifyCandidates && document.contextRequests.length > 0) {
    const reason = 'Discovery requested source follow-up, but independent verification is not enabled.';
    return {
      ...described,
      outcome: 'omitted', errorKind: 'verification-failed', reason,
      findings: [],
      rejectedCandidates: [...rejectedCandidates, ...findings.map((item) => ({
        index: candidateIndexes.get(item.id) as number,
        stage: 'verification' as const, code: 'follow-up-unavailable', reason,
      }))],
      ...(followUp === undefined ? {} : { followUp }),
      ...(followUpArtifact === undefined ? {} : { followUpArtifact }),
      durationMs: run.durationMs,
      rawModelOutput: redact(run.text),
    };
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
      ...(followUp === undefined ? {} : { followUp }),
      ...(followUpArtifact === undefined ? {} : { followUpArtifact }),
      durationMs: run.durationMs + (followUp?.durationMs ?? 0),
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
        ...(followUp === undefined ? {} : { followUp: {
          provider: indexedContext.coverage.provider,
          snapshot: indexedContext.coverage.provider === null ? null : bundle.manifest.base,
          status: followUp.status === 'completed' ? 'completed' as const : 'incomplete' as const,
          ...(followUp.reason === undefined ? {} : { reason: followUp.reason }),
          results: followUpResults,
        } }),
      });
      const verifiedRun = await executor.execute(prepared, verifierPrompt, {
        invocation: { fileId: file.id, path: fileReviewPath(file) },
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
        followUpSourcesByCandidate(followUpResults),
        fileContext.prompt,
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
        ...(followUp === undefined ? {} : { followUp }),
        ...(followUpArtifact === undefined ? {} : { followUpArtifact }),
        outcome: 'omitted',
        errorKind: 'verification-failed',
        reason,
        findings: [],
        rejectedCandidates,
        durationMs: run.durationMs + (followUp?.durationMs ?? 0) + verificationDurationMs,
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
    ...(followUp === undefined ? {} : { followUp }),
    ...(followUpArtifact === undefined ? {} : { followUpArtifact }),
    durationMs: run.durationMs + (followUp?.durationMs ?? 0) + verificationDurationMs,
    rawModelOutput: redact(run.text),
  };
}

type WritableFileReviewRecord = FileReviewRecord & {
  rawModelOutput?: string | undefined;
  verificationArtifact?: VerificationArtifact | undefined;
  followUpArtifact?: FollowUpArtifact | undefined;
};

interface ReviewTask {
  readonly file: ReviewManifestFile;
  readonly manifestIndex: number;
  readonly estimatedPromptBytes: number;
}

async function reviewTasks(
  bundle: ReviewBundle,
  concurrency: number,
  selectedManifestIndexes: ReadonlySet<number>,
): Promise<readonly ReviewTask[]> {
  const tasks = await Promise.all(bundle.manifest.files.flatMap((file, manifestIndex) =>
    file.reviewed && selectedManifestIndexes.has(manifestIndex)
      ? [stat(join(bundle.root, file.diffFile)).then(
          (value): ReviewTask => ({ file, manifestIndex, estimatedPromptBytes: value.size }),
          (): ReviewTask => ({
            file,
            manifestIndex,
            estimatedPromptBytes: (file.additions ?? 0) + (file.deletions ?? 0),
          }),
        )]
      : []));
  if (concurrency === 1) return tasks;
  return tasks.sort((left, right) =>
    right.estimatedPromptBytes - left.estimatedPromptBytes || left.manifestIndex - right.manifestIndex);
}

async function runBoundedWorkerPool<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let stopped = false;
  const failures: Array<{ readonly index: number; readonly error: unknown }> = [];
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        await worker(values[index] as T);
      } catch (error) {
        failures.push({ index, error });
        stopped = true;
      }
    }
  });
  await Promise.all(workers);
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index);
    throw failures[0]!.error;
  }
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
  // Independent verification is not active in production. Keep its shared
  // follow-up budgets manifest-ordered until the activation gate permits a
  // separately measured parallel verifier path.
  const verifyCandidates = input.verifyCandidates === true;
  const concurrency = verifyCandidates ? 1 : environment.reviewConcurrency;
  const reuseCache = environment.reuse === undefined
    ? undefined
    : await loadReviewReuseCache(environment.reuse);
  const recordsByManifestIndex = new Map<number, WritableFileReviewRecord>();
  const fingerprintsByManifestIndex = new Map<number, string>();
  let rejectedReuseCandidates = 0;

  // Restored data is processed before the worker queue exists. A cache
  // failure or current-evidence mismatch is only a miss: the file proceeds
  // through the normal harness path.
  if (reuseCache !== undefined) {
    for (const [manifestIndex, file] of bundle.manifest.files.entries()) {
      if (!file.reviewed || file.binary) continue;
      const fileContext = codeContextForFile(indexedContext, file);
      const followUpAvailable = verifyCandidates && environment.codeContext !== undefined
        && input.followUpExecutor !== undefined && fileContext.coverage.provider !== null;
      let fingerprint: string;
      try {
        fingerprint = await buildReviewSemanticFingerprint({
          bundle,
          file,
          environment,
          indexedContext,
          verifyCandidates,
          followUpAvailable,
        });
        fingerprintsByManifestIndex.set(manifestIndex, fingerprint);
      } catch {
        continue;
      }
      const candidate = reuseCache.match(fileReviewPath(file), fingerprint);
      if (candidate === undefined) continue;
      try {
        const record = await restoreReusableFileReview({
          candidate,
          bundle,
          file,
          environment,
          indexedContext,
          verifyCandidates,
        });
        await writer.writeFileReview(record);
        recordsByManifestIndex.set(manifestIndex, record);
        await reuseCache.write(
          record.path,
          fingerprint,
          bundle.manifest.base,
          bundle.manifest.head,
          record,
          record.savedDurationMs ?? 0,
          verifyCandidates,
        ).catch(() => undefined);
        input.onFileDone?.(record);
      } catch {
        // Cache content is untrusted and optional. A current-evidence
        // validation failure is counted and falls through to normal review.
        rejectedReuseCandidates += 1;
      }
    }
  }

  const selectedManifestIndexes = new Set(bundle.manifest.files.flatMap((file, manifestIndex) =>
    file.reviewed && !recordsByManifestIndex.has(manifestIndex) ? [manifestIndex] : []));
  const tasks = await reviewTasks(bundle, concurrency, selectedManifestIndexes);
  let workDirectory: string | undefined;
  try {
    if (tasks.length > 0) workDirectory = await mkdtemp(join(tmpdir(), 'redline-review-'));
    const prepared = tasks.length === 0
      ? undefined
      : await executor.prepare({
          model: environment.model,
          credential: environment.credential,
          timeoutMs: environment.timeout.milliseconds,
          workDirectory: workDirectory as string,
        });

    const followUpBudget = new FollowUpBudget();
    await runBoundedWorkerPool(tasks, concurrency, async ({ file, manifestIndex }) => {
      let record: WritableFileReviewRecord;
      if (file.binary) {
        record = {
          version: FILE_REVIEW_RECORD_VERSION,
          fileId: file.id,
          path: fileReviewPath(file),
          status: file.status,
          harness: environment.harness,
          model: environment.model.model,
          codeContext: codeContextForFile(indexedContext, file).coverage,
          execution: 'executed',
          outcome: 'omitted',
          reason: 'binary diff; not reviewable as text',
          findings: [],
          rejectedCandidates: [],
          durationMs: 0,
        };
      } else {
        const identity = { fileId: file.id, path: fileReviewPath(file) };
        input.onFileStart?.(identity);
        const onHarnessOutput = input.onHarnessOutput === undefined
          ? undefined
          : (output: HarnessOutputLine): void => input.onHarnessOutput?.({ ...identity, ...output });
        record = await reviewOneFile(
          executor,
          prepared as Awaited<ReturnType<HarnessExecutor['prepare']>>,
          environment,
          bundle,
          indexedContext,
          file,
          followUpBudget,
          input.followUpExecutor,
          onHarnessOutput,
          input.harnessStreamMode,
          verifyCandidates,
        );
        input.onFileValidated?.({
          ...identity,
          outcome: record.outcome,
          durationMs: record.durationMs,
          findingCount: record.findings.length,
          rejectedCandidateCount: record.rejectedCandidates.length,
        });
      }
      await writer.writeFileReview(record);
      recordsByManifestIndex.set(manifestIndex, record);
      const fingerprint = fingerprintsByManifestIndex.get(manifestIndex);
      if (reuseCache !== undefined && fingerprint !== undefined) {
        await reuseCache.write(
          record.path,
          fingerprint,
          bundle.manifest.base,
          bundle.manifest.head,
          record,
          record.durationMs,
          verifyCandidates,
        ).catch(() => undefined);
      }
      input.onFileDone?.(record);
    });

    const records = bundle.manifest.files.flatMap((file, manifestIndex) => {
      if (!file.reviewed) return [];
      const record = recordsByManifestIndex.get(manifestIndex);
      if (record === undefined) throw new Error('review run did not produce a file record');
      return [record];
    });
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
      reuse: {
        version: REVIEW_REUSE_TELEMETRY_VERSION,
        status: reuseCache === undefined ? 'disabled' : 'enabled',
        restoredEntries: reuseCache?.stats.restoredEntries ?? 0,
        invalidEntries: (reuseCache?.stats.invalidEntries ?? 0) + rejectedReuseCandidates,
        reusedFiles: records.filter((record) => record.execution === 'reused').length,
        executedFiles: records.filter((record) => record.execution !== 'reused').length,
        savedDurationMs: records.reduce((total, record) => total + (record.savedDurationMs ?? 0), 0),
      },
      files: records.map((record): ReviewRunSummaryFile => ({
        fileId: record.fileId,
        path: record.path,
        outcome: record.outcome,
        errorKind: record.errorKind,
        codeContext: record.codeContext,
        execution: record.execution,
        savedDurationMs: record.savedDurationMs,
        findingCount: record.findings.length,
        findingSpans: record.findings.map((finding) => formatSpan(finding.startLine, finding.endLine)),
      })),
    };
    await writer.writeSummary(summary);
    const review = buildPullRequestReview({
      bundle, environment, records, indexedContext, synthesize: verifyCandidates,
    });
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
    if (workDirectory !== undefined) await rm(workDirectory, { recursive: true, force: true });
  }
}
