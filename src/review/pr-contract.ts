import type { CodeContextDiagnostic, CodeContextTimings } from '../code-context/artifact.ts';
import type { ReviewBundle } from './bundle.ts';
import type { ReviewEnvironment } from './environment.ts';
import type { LoadedReviewCodeContext } from './indexed-context.ts';
import { MAX_FILE_FINDINGS } from './report.ts';
import { synthesizeReview } from './synthesis.ts';
import { validateSourceEvidence } from './source-evidence.ts';
import type {
  FileReviewRecord,
  FindingClassification,
  PullRequestFinding,
  PullRequestReviewCoverage,
  PullRequestReviewRecord,
  PullRequestVerdict,
  PublishedFinding,
  ReviewCoverageFacet,
  ReviewLimitation,
  ValidatedFinding,
} from './types.ts';
import { PULL_REQUEST_REVIEW_VERSION, REVIEW_RUN_SUMMARY_VERSION } from './types.ts';

function validateGraphReferences(
  bundle: ReviewBundle,
  finding: ValidatedFinding,
  context: LoadedReviewCodeContext,
): void {
  if (finding.graphReferences.length === 0) return;
  const provider = context.coverage.provider;
  const graphSnapshotRevision = context.graphSnapshotRevision;
  if (provider === null || graphSnapshotRevision === null) {
    throw new Error('graph reference is present without validated indexed context');
  }
  if (graphSnapshotRevision !== bundle.manifest.base) {
    throw new Error('validated indexed context does not match the reviewed base snapshot');
  }
  for (const reference of finding.graphReferences) {
    if (
      reference.provider !== provider.id
      || reference.providerVersion !== provider.version
      || reference.snapshotRevision !== graphSnapshotRevision
      || reference.capability !== 'related-spans'
    ) {
      throw new Error('graph reference does not match the validated base provider snapshot');
    }
    if (!context.graphFactDigests.has(reference.graphFactDigest)) {
      throw new Error('graph reference is not an action-produced fact from the loaded indexed context');
    }
  }
}

/** Re-resolves all non-trigger evidence before a finding can enter the PR contract. */
export async function validateFindingReferences(
  bundle: ReviewBundle,
  finding: ValidatedFinding,
  context: LoadedReviewCodeContext,
): Promise<ValidatedFinding> {
  for (const evidence of finding.supportingEvidence) await validateSourceEvidence(bundle, evidence);
  validateGraphReferences(bundle, finding, context);
  return finding;
}

function facet(status: ReviewCoverageFacet['status'], required: boolean, reason: string): ReviewCoverageFacet {
  return { status, required, reason };
}

function indexStatus(context: LoadedReviewCodeContext): ReviewCoverageFacet['status'] {
  if (context.coverage.status === 'disabled') return 'not-applicable';
  if (context.coverage.status === 'complete') return 'completed';
  if (context.coverage.status === 'partial') return 'incomplete';
  return 'unavailable';
}

function cacheStatus(
  diagnostics: readonly CodeContextDiagnostic[],
  timings: CodeContextTimings | null,
): PullRequestReviewCoverage['codeIntelligence']['cache'] {
  if (timings === null) return 'not-applicable';
  if (diagnostics.some((item) => item.code === 'cache-base-revision')) return 'restored';
  if (diagnostics.some((item) => item.code === 'graph-base-revision') || timings.indexMs > 0) return 'built';
  return 'unknown';
}

function coverageFor(
  bundle: ReviewBundle,
  records: readonly FileReviewRecord[],
  context: LoadedReviewCodeContext,
): PullRequestReviewCoverage {
  const considered = records.map((record) => record.path);
  const omitted = records.filter((record) => record.outcome === 'omitted').map((record) => record.path);
  const rejectedCandidates = records.reduce((count, record) => count + record.rejectedCandidates.length, 0);
  const verificationRejections = records.reduce((count, record) => count + record.rejectedCandidates.filter(
    (candidate) => candidate.stage === 'verification' &&
      (candidate.code === 'verification-rejected' || candidate.code === 'verification-duplicate'),
  ).length, 0);
  const baselineComplete = omitted.length === 0 && rejectedCandidates === verificationRejections;
  const verificationEnabled = records.some((record) => record.verification !== undefined);
  const verificationIncomplete = records.filter((record) =>
    record.verification !== undefined && record.verification.status === 'incomplete').length;
  const followUpRequested = records.reduce((total, record) => total + (record.followUp?.requested ?? 0), 0);
  const followUpIncomplete = records.filter((record) => record.followUp?.status === 'incomplete').length;
  const indexedStatus = indexStatus(context);
  const excluded = bundle.manifest.files
    .filter((file) => !file.reviewed)
    .map((file) => file.newPath ?? file.oldPath ?? file.id);
  return {
    files: {
      status: omitted.length === 0 ? 'completed' : 'incomplete',
      required: true,
      reason: omitted.length === 0
        ? `${considered.length} reviewable files produced records; ${excluded.length} files were excluded by bundle policy`
        : `${omitted.length} required files were omitted`,
      considered,
      omitted,
      excluded,
    },
    changedSymbols: facet(
      'unavailable',
      false,
      'The current file-review stage does not produce a validated changed-symbol inventory.',
    ),
    contextSources: [
      { source: 'diff', ...facet('completed', true, 'Authoritative base-to-head diffs were loaded for every reviewed file.') },
      { source: 'base-source', ...facet('completed', false, 'Captured base source was used when available for changed files.') },
      { source: 'head-source', ...facet('completed', false, 'Captured exact-head source remained authoritative for supporting evidence.') },
      {
        source: 'indexed-context',
        ...facet(indexedStatus, false, context.coverage.reason ?? `Indexed context status: ${context.coverage.status}.`),
      },
    ],
    specialists: [{
      id: 'baseline-file-review',
      ...facet(
        baselineComplete ? 'completed' : 'incomplete',
        true,
        baselineComplete
          ? 'Every required file review completed without unresolved invalid candidates.'
          : 'At least one required file was omitted or produced an invalid or inconclusive candidate.',
      ),
    }],
    verification: facet(
      !verificationEnabled ? 'not-applicable' : verificationIncomplete === 0 ? 'completed' : 'incomplete',
      verificationEnabled,
      !verificationEnabled
        ? 'Independent candidate verification was not enabled for this run.'
        : verificationIncomplete === 0
          ? 'Every required candidate-bearing file completed independent verification; clean files needed no verifier.'
          : `${verificationIncomplete} files did not complete required candidate verification.`,
    ),
    followUp: facet(
      followUpRequested === 0 ? 'not-applicable' : followUpIncomplete === 0 ? 'completed' : 'incomplete',
      followUpRequested > 0,
      followUpRequested === 0
        ? 'No candidate requested an action-owned follow-up.'
        : followUpIncomplete === 0
          ? `${followUpRequested} requested follow-up relationships were source-resolved.`
          : `${followUpIncomplete} files lack complete requested follow-up coverage.`,
    ),
    inspections: [
      { kind: 'tests', ...facet('unavailable', false, 'The discovery stage does not independently attest complete test inspection.') },
      { kind: 'contracts', ...facet('unavailable', false, 'The discovery stage does not independently attest complete contract inspection.') },
      { kind: 'schemas', ...facet('unavailable', false, 'The discovery stage does not independently attest complete schema inspection.') },
      { kind: 'configuration', ...facet('unavailable', false, 'The discovery stage does not independently attest complete configuration inspection.') },
    ],
    codeIntelligence: {
      ...facet(indexedStatus, false, context.coverage.reason ?? `Indexed context status: ${context.coverage.status}.`),
      provider: context.coverage.provider,
      baseSnapshot: bundle.manifest.base,
      headSnapshot: bundle.manifest.head,
      capabilities: context.coverage.provider === null ? [] : ['related-spans'],
      cache: cacheStatus(context.diagnostics, context.timings),
      diagnostics: context.diagnostics.map((item) => item.code),
    },
    graphQueries: [facet(
      indexedStatus,
      false,
      context.coverage.provider === null
        ? 'No code-intelligence graph query was configured.'
        : `${context.coverage.relatedSpans} bounded related-span results were source-resolved.`,
    )],
    impactTraversals: [facet(
      indexedStatus,
      false,
      context.coverage.provider === null
        ? 'No code-intelligence impact traversal was configured.'
        : 'The action supplied bounded provider relationships; no exhaustive traversal is claimed.',
    )],
    relationships: {
      sourceConfirmed: context.coverage.relatedSpans,
      providerDerived: context.coverage.relatedSpans,
      providerDisagreement: context.diagnostics
        .filter((item) => item.code.includes('disagreement'))
        .map((item) => item.code),
      unresolvedSymbols: context.diagnostics
        .filter((item) => item.code.includes('unresolved'))
        .map((item) => item.code),
      unsupportedLanguages: context.diagnostics
        .filter((item) => item.code.includes('unsupported'))
        .map((item) => item.code),
      dynamicBehaviorUncertainty: context.coverage.provider === null
        ? ['Dynamic behavior was not evaluated by code intelligence.']
        : ['Bounded static relationships may not capture runtime-only behavior.'],
    },
    truncation: facet(
      context.coverage.reason === 'source-byte-limit' ? 'incomplete' : 'completed',
      false,
      context.coverage.reason === 'source-byte-limit'
        ? 'Indexed source context reached its byte budget.'
        : 'No indexed source byte truncation was recorded.',
    ),
    rejectedCandidates,
    verificationRejections,
    remediation: facet('completed', false, 'Every validated finding carries deterministic remediation guidance.'),
    fixVerification: facet(
      records.some((record) => record.findings.length > 0) ? 'unavailable' : 'not-applicable',
      false,
      'Independent fix verification belongs to a later review stage.',
    ),
    budgets: {
      maximumFindingsPerFile: MAX_FILE_FINDINGS,
      indexedContextBytes: context.coverage.sourceBytes,
      indexedContextSpans: context.coverage.relatedSpans,
    },
  };
}

function limitationsFor(
  coverage: PullRequestReviewCoverage,
  context: LoadedReviewCodeContext,
): readonly ReviewLimitation[] {
  const limitations: ReviewLimitation[] = [];
  if (coverage.files.omitted.length > 0) {
    limitations.push({
      code: 'required-files-omitted',
      required: true,
      message: `${coverage.files.omitted.length} required files did not produce a complete review.`,
    });
  }
  const invalidCandidates = coverage.rejectedCandidates - (coverage.verificationRejections ?? 0);
  if (invalidCandidates > 0) {
    limitations.push({
      code: 'candidates-rejected',
      required: true,
      message: `${invalidCandidates} candidates failed required schema, evidence, or verifier validation.`,
    });
  }
  if ((coverage.verificationRejections ?? 0) > 0) {
    limitations.push({
      code: 'candidates-disproved',
      required: false,
      message: `${coverage.verificationRejections} discovery candidates were disproved or deduplicated by the verifier.`,
    });
  }
  if (context.coverage.status !== 'complete') {
    limitations.push({
      code: 'indexed-context-degraded',
      required: false,
      message: context.coverage.reason ?? `Indexed context status was ${context.coverage.status}.`,
    });
  }
  limitations.push({
    code: 'changed-symbol-coverage-unavailable',
    required: false,
    message: 'Changed-symbol coverage is not produced by the current file-review stage.',
  });
  if (coverage.followUp?.status === 'incomplete') {
    limitations.push({
      code: 'follow-up-incomplete', required: true, message: coverage.followUp.reason,
    });
  }
  if (coverage.verification?.status === 'incomplete') {
    limitations.push({
      code: 'candidate-verification-incomplete',
      required: true,
      message: coverage.verification.reason,
    });
  } else if (coverage.verification?.status === 'not-applicable') {
    limitations.push({
      code: 'independent-verification-not-run',
      required: false,
      message: 'Candidate falsification and fix verification have not run.',
    });
  }
  return limitations;
}

function decisionFinding(classification: FindingClassification): boolean {
  return classification !== 'defect';
}

/** Deterministic verdict policy. Model prose cannot choose the verdict. */
export function derivePullRequestVerdict(
  findings: readonly PullRequestFinding[],
  coverage: PullRequestReviewCoverage,
): PullRequestVerdict {
  const unresolved = findings.filter((finding) =>
    finding.verification.status !== 'confirmed' || finding.remediationStatus !== 'verified');
  const blockers = unresolved.filter((finding) => !decisionFinding(finding.classification));
  if (blockers.length > 0) {
    return {
      status: 'blocked',
      reasons: blockers.map((finding) => `${finding.id}: unresolved ${finding.severity} ${finding.classification}`),
    };
  }
  const decisions = unresolved.filter((finding) => decisionFinding(finding.classification));
  if (decisions.length > 0) {
    return {
      status: 'human-decision-required',
      reasons: decisions.map((finding) => `${finding.id}: ${finding.classification} requires human judgment`),
    };
  }
  const requiredIncomplete = [
    coverage.files,
    ...coverage.contextSources,
    ...coverage.specialists,
    ...(coverage.verification === undefined ? [] : [coverage.verification]),
    ...(coverage.followUp === undefined ? [] : [coverage.followUp]),
    ...(coverage.publication === undefined ? [] : [coverage.publication]),
    ...coverage.inspections,
    coverage.changedSymbols,
    coverage.codeIntelligence,
    coverage.truncation,
  ].filter((item) => item.required && item.status !== 'completed' && item.status !== 'not-applicable');
  const invalidCandidates = coverage.rejectedCandidates - (coverage.verificationRejections ?? 0);
  if (requiredIncomplete.length > 0 || invalidCandidates > 0) {
    return {
      status: 'inconclusive',
      reasons: [
        ...requiredIncomplete.map((item) => item.reason),
        ...(invalidCandidates > 0 ? [`${invalidCandidates} candidates failed required validation`] : []),
      ],
    };
  }
  if (findings.length > 0) {
    return {
      status: 'mergeable-after-verified-fixes',
      reasons: ['All findings and their remediations are recorded as independently verified.'],
    };
  }
  return { status: 'mergeable', reasons: ['No validated findings remain and all required coverage completed.'] };
}

export interface BuildPullRequestReviewInput {
  readonly bundle: ReviewBundle;
  readonly environment: Pick<ReviewEnvironment, 'harness' | 'model' | 'findingScope'>;
  readonly records: readonly FileReviewRecord[];
  readonly indexedContext: LoadedReviewCodeContext;
  readonly synthesize?: boolean | undefined;
}

export function buildPullRequestReview(input: BuildPullRequestReviewInput): PullRequestReviewRecord {
  const findings: PullRequestFinding[] = input.records.flatMap((record) =>
    record.findings.map((finding): PullRequestFinding => ({
      ...finding,
      triggerFileId: record.fileId,
      triggerPath: record.path,
    })));
  const rejectedCandidates = input.records.flatMap((record) =>
    record.rejectedCandidates.map((candidate) => ({ ...candidate, fileId: record.fileId, path: record.path })));
  const synthesis = input.synthesize === true ? synthesizeReview(findings) : undefined;
  const conflicts = synthesis?.groups.filter((group) => group.status === 'conflict') ?? [];
  const budgetSuppressed = synthesis?.decisions.filter((item) =>
    item.status === 'file-budget' || item.status === 'comment-budget') ?? [];
  const criticalBudgetSuppressed = budgetSuppressed.filter((decision) => findings.some((finding) =>
    finding.id === decision.findingId && finding.triggerFileId === decision.fileId && finding.severity === 'critical'));
  const unverified = synthesis?.decisions.filter((decision) => decision.status === 'unverified') ?? [];
  const coverage: PullRequestReviewCoverage = {
    ...coverageFor(input.bundle, input.records, input.indexedContext),
    ...(synthesis === undefined ? {} : { publication: facet(
      conflicts.length + criticalBudgetSuppressed.length + unverified.length > 0 ? 'incomplete' : 'completed',
      conflicts.length + criticalBudgetSuppressed.length + unverified.length > 0,
      `${synthesis.decisions.filter((item) => item.status === 'publish').length} ranked comments eligible; ${budgetSuppressed.length} budget-suppressed; ${conflicts.length} source-backed disagreements`,
    ) }),
  };
  const limitations = [
    ...limitationsFor(coverage, input.indexedContext),
    ...(conflicts.length === 0 ? [] : [{ code: 'source-claim-conflict', required: true,
      message: `${conflicts.length} source-backed claim groups disagree; human judgment is required.` }]),
    ...(criticalBudgetSuppressed.length === 0 ? [] : [{ code: 'critical-publication-suppressed', required: true,
      message: `${criticalBudgetSuppressed.length} confirmed critical findings exceeded the publication budget.` }]),
    ...(budgetSuppressed.length === 0 ? [] : [{ code: 'publication-truncated', required: false,
      message: `${budgetSuppressed.length} ranked findings exceeded the publication budget; see synthesis decisions.` }]),
    ...(unverified.length === 0 ? [] : [{ code: 'synthesis-unverified', required: true,
      message: `${unverified.length} publication representatives lacked independent confirmation.` }]),
  ];
  const conflictedIds = new Set(conflicts.flatMap((group) => group.triggers.map((item) =>
    `${item.fileId}:${item.findingId}`)));
  const coherentFindings = findings.filter((finding) =>
    !conflictedIds.has(`${finding.triggerFileId}:${finding.id}`));
  const baselineVerdict = derivePullRequestVerdict(coherentFindings, coverage);
  const verdict: PullRequestVerdict = conflicts.length > 0
    ? {
      status: baselineVerdict.status === 'blocked' ? 'blocked' : 'human-decision-required',
      reasons: [...baselineVerdict.reasons, ...conflicts.map((group) =>
        `${group.id}: incompatible source-backed contracts require human judgment`)],
    }
    : baselineVerdict;
  return {
    version: PULL_REQUEST_REVIEW_VERSION,
    harness: input.environment.harness,
    model: input.environment.model.model,
    provider: input.environment.model.provider,
    findingScope: input.environment.findingScope,
    base: input.bundle.manifest.base,
    head: input.bundle.manifest.head,
    findings,
    ...(synthesis === undefined ? {} : { synthesis }),
    rejectedCandidates,
    coverage,
    limitations,
    verdict,
    files: input.records.map((record) => ({
      fileId: record.fileId,
      path: record.path,
      outcome: record.outcome,
      findingIds: record.findings.map((finding: PublishedFinding) => finding.id),
      rejectedCandidates: record.rejectedCandidates.length,
      codeContext: record.codeContext,
    })),
    legacySummaryVersion: REVIEW_RUN_SUMMARY_VERSION,
  };
}
