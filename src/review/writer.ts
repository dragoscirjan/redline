/**
 * Persists per-file review records and the run summary as JSON and Markdown
 * files in the output directory. The JSON files are the machine-readable
 * contract for later comment publication; the Markdown files are the
 * human-readable counterpart, presenting findings as `path:x-y` spans with
 * their change suggestions and fix prompts.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FollowUpRequestBatch } from '../code-context/follow-up.ts';
import type { ResolvedFollowUp } from './follow-up.ts';
import { spanLocation } from './remediation.ts';
import type {
  FileReviewRecord,
  PublishedFinding,
  PullRequestReviewRecord,
  ReviewRunSummary,
} from './types.ts';

export const MAX_RAW_MODEL_OUTPUT_BYTES = 16 * 1024;

export interface VerificationArtifact {
  readonly version: 1;
  readonly candidateIds: readonly string[];
  readonly status: 'completed' | 'incomplete';
  readonly dispositions: readonly {
    readonly candidateId: string;
    readonly disposition: string;
    readonly reason: string;
  }[];
  readonly rawModelOutput?: string | undefined;
}

export interface FollowUpArtifact {
  readonly version: 1;
  readonly requests: FollowUpRequestBatch | null;
  readonly results: readonly ResolvedFollowUp[];
  readonly reason?: string | undefined;
}

interface FileReviewRecordWithRaw extends FileReviewRecord {
  readonly rawModelOutput?: string | undefined;
  readonly verificationArtifact?: VerificationArtifact | undefined;
  readonly followUpArtifact?: FollowUpArtifact | undefined;
}

/** Uses a fence that cannot occur inside the fenced content. */
function fenceFor(content: string): string {
  return content.includes('```') ? '````' : '```';
}

function renderFindingMarkdown(finding: PublishedFinding, index: number, path: string): string {
  const location = spanLocation(path, finding.startLine, finding.endLine);
  const lines = [
    `### Finding ${index + 1}: ${finding.title}`,
    '',
    `- **Location:** ${location} (side ${finding.side})`,
    `- **Classification:** ${finding.severity} ${finding.classification}`,
    `- **Dimensions:** ${finding.dimensions.join(', ')}`,
    `- **Confidence:** ${finding.confidence}`,
    `- **Evidence (line ${finding.startLine}):** \`${finding.evidence.replace(/`/gu, '\\`')}\``,
    `- **Behavioral contract:** ${finding.behavioralContract}`,
    `- **Failure scenario:** ${finding.failureScenario}`,
    `- **Reachability:** ${finding.reachability}`,
    `- **Root cause:** ${finding.rootCause}`,
    `- **Impact:** ${finding.impact}`,
    `- **Blast radius:** ${finding.blastRadius}`,
    `- **Reversibility:** ${finding.reversibility}`,
    `- **Uncertainty:** ${finding.uncertainty}`,
    `- **Verification:** ${finding.verification.status} — ${finding.verification.reason}`,
    `- **Remediation:** ${finding.remediationStatus}; ${finding.fix}`,
    `- **Regression test:** ${finding.regressionTest}`,
  ];
  if (finding.supportingEvidence.length > 0) {
    lines.push('', '**Supporting source evidence:**', '');
    for (const evidence of finding.supportingEvidence) {
      lines.push(`- ${evidence.role}: \`${evidence.path}:${evidence.startLine}-${evidence.endLine}\` at \`${evidence.revision.slice(0, 12)}\``);
    }
  }
  if (finding.graphReferences.length > 0) {
    lines.push('', '**Derived graph references (not source authority):**', '');
    for (const reference of finding.graphReferences) {
      lines.push(`- ${reference.provider} ${reference.providerVersion}: ${reference.relationship} (${reference.resolution}, ${reference.graphFactDigest})`);
    }
  }
  lines.push('', `**Impact path:** ${finding.impactPath.status}`);
  for (const step of finding.impactPath.steps) {
    lines.push(`- ${step.from} → ${step.to}: ${step.relationship} (${step.evidence} evidence ${step.referenceIndex})`);
  }
  if (finding.impactPath.limitation !== undefined) {
    lines.push(`- Limitation: ${finding.impactPath.limitation}`);
  }
  if (finding.suggestion !== undefined) {
    lines.push('', `**Suggested change** for ${location} (side ${finding.side}):`, '');
    lines.push(`\`\`\`diff`);
    lines.push(finding.suggestion);
    lines.push('```');
  }
  lines.push('', '**Fix prompt** for a coding agent:', '');
  lines.push(fenceFor(finding.fixPrompt) === '```' ? '```text' : '````text');
  lines.push(finding.fixPrompt);
  lines.push(fenceFor(finding.fixPrompt) === '```' ? '```' : '````');
  lines.push('');
  return lines.join('\n');
}

function renderRecordMarkdown(record: FileReviewRecord): string {
  const lines = [
    `# Review: ${record.path}`,
    '',
    `- **File id:** ${record.fileId}`,
    `- **Change status:** ${record.status}`,
    `- **Outcome:** ${record.outcome}`,
    `- **Harness:** ${record.harness} (${record.model})`,
    `- **Duration:** ${record.durationMs} ms`,
    `- **Execution:** ${record.execution ?? 'executed'}`,
    ...(record.savedDurationMs === undefined ? [] : [`- **Estimated model time saved:** ${record.savedDurationMs} ms`]),
    `- **Indexed context:** ${record.codeContext.status}; ${record.codeContext.relatedSpans} spans, ${record.codeContext.sourceBytes} source bytes`,
  ];
  if (record.codeContext.provider !== null) {
    lines.push(`- **Index provider:** ${record.codeContext.provider.id} ${record.codeContext.provider.version}`);
  }
  if (record.codeContext.reason !== null) lines.push(`- **Index coverage reason:** ${record.codeContext.reason}`);
  if (record.followUp !== undefined) {
    lines.push(`- **Follow-up queries:** ${record.followUp.status}; ${record.followUp.completed}/${record.followUp.requested} completed; ${record.followUp.omitted} omitted`);
    if (record.followUp.reason !== undefined) lines.push(`- **Follow-up limitation:** ${record.followUp.reason}`);
  }
  if (record.verification !== undefined) {
    lines.push(`- **Candidate verification:** ${record.verification.status}; ${record.verification.accepted}/${record.verification.requested} accepted; ${record.verification.durationMs} ms`);
    if (record.verification.reason !== undefined) lines.push(`- **Verification limitation:** ${record.verification.reason}`);
  }
  if (record.reason !== undefined) lines.push(`- **Reason:** ${record.reason}`);
  if (record.errorKind !== undefined) lines.push(`- **Error kind:** ${record.errorKind}`);
  lines.push(`- **Rejected candidates:** ${record.rejectedCandidates.length}`);
  lines.push('', '');
  if (record.findings.length === 0) {
    lines.push(record.outcome === 'clean' ? 'No findings.' : 'No validated findings.');
  } else {
    lines.push(`## Findings (${record.findings.length})`, '');
    record.findings.forEach((finding, index) => {
      lines.push(renderFindingMarkdown(finding, index, record.path));
    });
  }
  return `${lines.join('\n')}\n`;
}

function renderSummaryMarkdown(summary: ReviewRunSummary): string {
  const lines = [
    `# Review run summary`,
    '',
    `- **Revisions:** ${summary.base.slice(0, 12)}..${summary.head.slice(0, 12)}`,
    `- **Harness:** ${summary.harness} (${summary.provider}/${summary.model})`,
    `- **Finding scope:** ${summary.findingScope}`,
    `- **Manifest files:** ${summary.manifestFiles}`,
    `- **Reviewed:** ${summary.reviewedFiles}`,
    `- **Omitted:** ${summary.omittedFiles}`,
    `- **Findings:** ${summary.findings}`,
    `- **Indexed context:** ${summary.codeContext.status}; ${summary.codeContext.filesWithContext} files, ${summary.codeContext.relatedSpans} spans, ${summary.codeContext.sourceBytes} source bytes`,
    `- **Index cache:** ${summary.codeContext.cache}`,
    ...(summary.codeContext.timings === null ? [] : [
      `- **Index timings:** install ${summary.codeContext.timings.installationMs} ms, restore ${summary.codeContext.timings.restoreMs} ms, validate ${summary.codeContext.timings.validationMs ?? 0} ms, index ${summary.codeContext.timings.indexMs} ms, query ${summary.codeContext.timings.queryMs} ms, save ${summary.codeContext.timings.saveMs === null ? 'n/a' : `${summary.codeContext.timings.saveMs} ms`}`,
    ]),
    ...(summary.codeContext.diagnosticCodes.length === 0 ? [] : [
      `- **Index diagnostics:** ${summary.codeContext.diagnosticCodes.join(', ')}`,
    ]),
    ...(summary.reuse === undefined ? [] : [
      `- **Review reuse:** ${summary.reuse.status}; ${summary.reuse.reusedFiles} reused, ${summary.reuse.executedFiles} executed, ${summary.reuse.savedDurationMs} ms estimated saved`,
      `- **Restored cache:** ${summary.reuse.restoredEntries} valid entries, ${summary.reuse.invalidEntries} invalid entries ignored`,
    ]),
    '',
    '## Files',
    '',
    '| File | Outcome | Execution | Findings | Indexed context |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const file of summary.files) {
    const spans =
      file.findingCount > 0 && file.findingSpans.length > 0
        ? ` (${file.findingSpans.join(', ')})`
        : '';
    lines.push(
      `| ${file.path} | ${file.outcome} | ${file.execution ?? 'executed'} | ${file.findingCount}${spans} | ${file.codeContext.status} (${file.codeContext.relatedSpans} spans) |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderPullRequestReviewMarkdown(review: PullRequestReviewRecord): string {
  const lines = [
    '# Pull request review',
    '',
    `- **Revisions:** ${review.base.slice(0, 12)}..${review.head.slice(0, 12)}`,
    `- **Verdict:** ${review.verdict.status}`,
    `- **Findings:** ${review.findings.length}`,
    `- **Rejected candidates:** ${review.rejectedCandidates.length}`,
    `- **Required file coverage:** ${review.coverage.files.status}`,
    `- **Baseline review coverage:** ${review.coverage.specialists[0]?.status ?? 'unavailable'}`,
    ...(review.coverage.verification === undefined ? [] : [`- **Candidate verification:** ${review.coverage.verification.status}`]),
    ...(review.coverage.followUp === undefined ? [] : [`- **Follow-up queries:** ${review.coverage.followUp.status}`]),
    ...(review.coverage.publication === undefined ? [] : [`- **Publication budget:** ${review.coverage.publication.status} — ${review.coverage.publication.reason}`]),
    `- **Indexed context:** ${review.coverage.codeIntelligence.status}`,
    `- **Graph queries:** ${review.coverage.graphQueries.map((item) => item.status).join(', ')}`,
    `- **Impact traversals:** ${review.coverage.impactTraversals.map((item) => item.status).join(', ')}`,
    `- **Relationships:** ${review.coverage.relationships.sourceConfirmed} source-confirmed / ${review.coverage.relationships.providerDerived} provider-derived`,
    '',
    '## Verdict reasons',
    '',
    ...review.verdict.reasons.map((reason) => `- ${reason}`),
    '',
    '## Limitations',
    '',
    ...review.limitations.map((limitation) => `- ${limitation.required ? 'Required' : 'Advisory'} — ${limitation.code}: ${limitation.message}`),
    '',
    '## Findings',
    '',
  ];
  if (review.findings.length === 0) lines.push('No validated findings.');
  for (const finding of review.findings) {
    lines.push(`- **${finding.title}** — \`${finding.triggerPath}:${finding.startLine}-${finding.endLine}\` (${finding.severity} ${finding.classification})`);
  }
  if (review.synthesis !== undefined) {
    lines.push('', '## Source-backed root-cause groups', '');
    for (const group of review.synthesis.groups) {
      lines.push(`- \`${group.id}\`: ${group.status}; ${group.triggers.length} changed-line trigger(s); ${group.supportingEvidence.length} source anchor(s).`);
    }
    lines.push('', '## Publication decisions', '');
    for (const decision of review.synthesis.decisions) {
      lines.push(`- \`${decision.fileId}:${decision.findingId}\`: ${decision.status} — ${decision.reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface ReviewWriter {
  writeFileReview(record: FileReviewRecordWithRaw): Promise<void>;
  writeSummary(summary: ReviewRunSummary): Promise<void>;
  writePullRequestReview(review: PullRequestReviewRecord): Promise<void>;
}

/**
 * Creates a writer bound to one output directory. Files are written under
 * the caller's output directory; the directory is created on first use.
 */
export function createReviewWriter(outputDirectory: string): ReviewWriter {
  const reviewsDirectory = join(outputDirectory, 'reviews');
  let preparation: Promise<void> | undefined;
  const prepare = async (): Promise<void> => {
    preparation ??= mkdir(reviewsDirectory, { recursive: true }).then(() => undefined);
    await preparation;
  };
  return {
    async writeFileReview(record: FileReviewRecordWithRaw): Promise<void> {
      await prepare();
      const { rawModelOutput, verificationArtifact, followUpArtifact, ...rest } = record;
      const json: Record<string, unknown> = { ...rest };
      if (rawModelOutput !== undefined) {
        json['rawModelOutput'] =
          rawModelOutput.length > MAX_RAW_MODEL_OUTPUT_BYTES
            ? rawModelOutput.slice(0, MAX_RAW_MODEL_OUTPUT_BYTES)
            : rawModelOutput;
      }
      await writeFile(join(reviewsDirectory, `${record.fileId}.json`), `${JSON.stringify(json, null, 2)}\n`);
      await writeFile(join(reviewsDirectory, `${record.fileId}.md`), renderRecordMarkdown(record));
      if (followUpArtifact !== undefined) {
        const directory = join(reviewsDirectory, 'follow-up');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${record.fileId}.json`), `${JSON.stringify(followUpArtifact, null, 2)}\n`);
      }
      if (verificationArtifact !== undefined) {
        const directory = join(reviewsDirectory, 'verification');
        await mkdir(directory, { recursive: true });
        const bounded = {
          ...verificationArtifact,
          ...(verificationArtifact.rawModelOutput === undefined ? {} : {
            rawModelOutput: verificationArtifact.rawModelOutput.slice(0, MAX_RAW_MODEL_OUTPUT_BYTES),
          }),
        };
        await writeFile(join(directory, `${record.fileId}.json`), `${JSON.stringify(bounded, null, 2)}\n`);
      }
    },
    async writeSummary(summary: ReviewRunSummary): Promise<void> {
      await prepare();
      await writeFile(join(reviewsDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      await writeFile(join(reviewsDirectory, 'summary.md'), renderSummaryMarkdown(summary));
    },
    async writePullRequestReview(review: PullRequestReviewRecord): Promise<void> {
      await prepare();
      await writeFile(join(reviewsDirectory, 'review.json'), `${JSON.stringify(review, null, 2)}\n`);
      await writeFile(join(reviewsDirectory, 'review.md'), renderPullRequestReviewMarkdown(review));
    },
  };
}

