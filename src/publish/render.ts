/**
 * Renders the managed publication bodies.
 *
 * Every body ends with its machine-readable hidden marker so the publisher
 * can find, own, and deduplicate its objects. Finding text is model output;
 * it is embedded as quoted review data and never alters the structure.
 */

import { spanLocation } from '../review/remediation.js';
import type { FileReviewRecord, PublishedFinding, PullRequestReviewRecord } from '../review/types.js';
import type { ReviewScope } from './types.js';

export function summaryMarker(scope: ReviewScope): string {
  return `<!-- redline:summary:v2 repository=${encodeURIComponent(scope.repository)} pr=${scope.pullRequest} -->`;
}

export function fileReviewMarker(scope: ReviewScope, fileId: string): string {
  return `<!-- redline:file:v1 file=${fileId} head=${scope.head} -->`;
}

export function findingMarker(scope: ReviewScope, findingId: string): string {
  return `<!-- redline:finding:v1 id=${findingId} head=${scope.head} -->`;
}

function escapeBackticks(value: string): string {
  return value.replace(/`/gu, '\\`');
}

/**
 * Chooses a fence longer than any backtick run inside the content, so
 * model text or reviewed file content containing triple backticks cannot
 * close the fence early and break the comment structure.
 */
function fenceFor(content: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/gu) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longestRun + 1));
}

/**
 * GitHub suggestion blocks replace the anchored span lines with the block
 * content verbatim, so the block carries only the replacement lines — the
 * unified `-`/`+` markers from the record's suggestion are stripped here.
 * A delete-only proposal (no replacement lines) cannot be expressed as an
 * apply-able block; it stays a `diff` quote instead.
 */
function replacementLines(suggestion: string): string[] {
  return suggestion
    .split('\n')
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1));
}

/**
 * Renders one finding's inline comment: the explanation, the native
 * apply-able suggestion block, and the fix prompt in a collapsed details
 * section — the two remediation fields of the published record.
 */
export function renderFindingComment(
  scope: ReviewScope,
  path: string,
  finding: PublishedFinding,
): string {
  const location = spanLocation(path, finding.startLine, finding.endLine);
  const lines = [
    `**${finding.title}** — \`${location}\` (side ${finding.side})`,
    '',
    `- **Classification:** ${finding.severity} ${finding.classification}; confidence ${finding.confidence}`,
    `- **Dimensions:** ${finding.dimensions.join(', ')}`,
    `- **Evidence (line ${finding.startLine}):** \`${escapeBackticks(finding.evidence)}\``,
    `- **Behavioral contract:** ${finding.behavioralContract}`,
    `- **Failure scenario:** ${finding.failureScenario}`,
    `- **Root cause:** ${finding.rootCause}`,
    `- **Impact:** ${finding.impact}`,
    `- **Impact path:** ${finding.impactPath.status}${finding.impactPath.limitation === undefined ? '' : ` — ${finding.impactPath.limitation}`}`,
    `- **Verification:** ${finding.verification.status} — ${finding.verification.reason}`,
    `- **Fix:** ${finding.fix}`,
    `- **Regression test:** ${finding.regressionTest}`,
  ];
  if (finding.suggestion !== undefined) {
    const replacement = replacementLines(finding.suggestion);
    if (replacement.length > 0) {
      const block = replacement.join('\n');
      lines.push('', '**Suggested change** (apply-able):', '');
      lines.push(`${fenceFor(block)}suggestion`);
      lines.push(block);
      lines.push(fenceFor(block));
    } else {
      lines.push('', '**Suggested change** (delete-only; apply manually):', '');
      const diffFence = fenceFor(finding.suggestion);
      lines.push(`${diffFence}diff`);
      lines.push(finding.suggestion);
      lines.push(diffFence);
    }
  }
  lines.push('', '<details><summary>Fix prompt for a coding agent</summary>', '');
  lines.push(`${fenceFor(finding.fixPrompt)}text`);
  lines.push(finding.fixPrompt);
  lines.push(fenceFor(finding.fixPrompt));
  lines.push('', '</details>');
  lines.push('', findingMarker(scope, finding.id));
  return lines.join('\n');
}

/** Renders the review body for one file: the file record plus the marker. */
export function renderFileReviewBody(scope: ReviewScope, record: FileReviewRecord): string {
  const findings = record.findings;
  const spanList = findings
    .map((finding) => `\`${spanLocation(record.path, finding.startLine, finding.endLine)}\``)
    .join(', ');
  const lines = [
    `## Redline review: ${record.path}`,
    '',
    `- **File id:** ${record.fileId}`,
    `- **Outcome:** ${record.outcome} — ${findings.length} validated finding${findings.length === 1 ? '' : 's'}`,
    `- **Review duration:** ${record.durationMs} ms`,
    `- **Rejected candidates:** ${record.rejectedCandidates.length}`,
    '',
    `Findings${spanList.length > 0 ? ` (${spanList})` : ''} are attached as inline comments with apply-able suggestions and fix prompts. All findings are validated against the reviewed diff before publication.`,
    '',
    fileReviewMarker(scope, record.fileId),
  ];
  return lines.join('\n');
}

export interface RunningSummaryInfo {
  readonly harness: string;
  readonly model: string;
  /** ISO timestamp captured when the review run started. */
  readonly startedAt: string;
}

/**
 * Renders the running body published while the review executes. It ends
 * with the standard summary marker, so the final summary upserts this
 * comment in place instead of adding a second one.
 */
export function renderRunningSummaryBody(scope: ReviewScope, info: RunningSummaryInfo): string {
  const lines = [
    '## Redline review in progress',
    '',
    `- **Started at:** ${info.startedAt}`,
    `- **Harness:** ${info.harness} (${info.model})`,
    '',
    'The review runs one prompt per reviewed file and can take a while. Findings will be attached as inline comments, and this comment will be replaced by the run summary when the review completes.',
    '',
    summaryMarker(scope),
  ];
  return lines.join('\n');
}

/**
 * Renders the body published when the review run itself fails, so the
 * comment does not stay at "running". The message is caller-redacted and
 * bounded; it ends with the summary marker for the same in-place update.
 */
export function renderFailedSummaryBody(scope: ReviewScope, info: RunningSummaryInfo, message: string): string {
  const bounded = message.slice(0, 500).replaceAll(/[\u0000-\u001f]+/gu, ' ');
  const lines = [
    '## Redline review failed',
    '',
    `- **Started at:** ${info.startedAt}`,
    `- **Harness:** ${info.harness} (${info.model})`,
    `- **Reason:** ${bounded}`,
    '',
    'No findings were published. The run artifacts contain the diagnostics.',
    '',
    summaryMarker(scope),
  ];
  return lines.join('\n');
}

export interface SummaryPublicationNotes {
  /** Number of file reviews published this run. */
  readonly publishedFileReviews: number;
  /** Number of file review publications that failed this run. */
  readonly failedFileReviews: number;
  /** Findings whose inline comments could not be published this run. */
  readonly failedInlineComments: number;
}

/** Renders the managed run summary body, ending with its marker. */
export function renderSummaryBody(
  scope: ReviewScope,
  review: PullRequestReviewRecord,
  notes: SummaryPublicationNotes,
): string {
  const omitted = review.files.filter((file) => file.outcome === 'omitted').length;
  const lines = [
    '## Redline pull request review',
    '',
    `- **Verdict:** ${review.verdict.status}`,
    `- **Revisions:** \`${review.base.slice(0, 12)}\`…\`${review.head.slice(0, 12)}\``,
    `- **Harness:** ${review.harness} (${review.provider}/${review.model})`,
    `- **Finding scope:** ${review.findingScope}`,
    `- **Files:** ${review.files.length} reviewed · ${omitted} omitted`,
    `- **Findings:** ${review.findings.length}`,
    `- **Rejected candidates:** ${review.rejectedCandidates.length}`,
    `- **Required coverage:** files ${review.coverage.files.status}; baseline review ${review.coverage.specialists[0]?.status ?? 'unavailable'}`,
    `- **Code intelligence:** ${review.coverage.codeIntelligence.status}; base ${review.coverage.codeIntelligence.baseSnapshot.slice(0, 12)}; head ${review.coverage.codeIntelligence.headSnapshot.slice(0, 12)}`,
  ];
  if (review.synthesis !== undefined) {
    const suppressed = review.synthesis.decisions.filter((decision) =>
      decision.status !== 'publish' && decision.status !== 'duplicate');
    const duplicates = review.synthesis.decisions.filter((decision) => decision.status === 'duplicate').length;
    lines.push(`- **Synthesis:** ${review.synthesis.groups.length} root-cause groups; ${duplicates} duplicate comments consolidated; ${suppressed.length} findings withheld`);
    const consolidated = review.synthesis.groups.filter((group) => group.triggers.length > 1);
    if (consolidated.length > 0) {
      lines.push('', '**Consolidated changed-line triggers** (full source anchors in review.json):');
      for (const group of consolidated.slice(0, 16)) {
        const triggers = group.triggers.slice(0, 8).map((item) =>
          `\`${escapeBackticks(item.path)}:${item.startLine}-${item.endLine}\``).join(', ');
        lines.push(`- \`${group.id}\` — ${group.status}; ${triggers}${group.triggers.length > 8 ? `, and ${group.triggers.length - 8} more` : ''}`);
      }
      if (consolidated.length > 16) lines.push(`- …${consolidated.length - 16} more groups in review.json.`);
    }
    if (suppressed.length > 0) {
      const critical = new Set(review.findings.filter((finding) => finding.severity === 'critical')
        .map((finding) => `${finding.triggerFileId}:${finding.id}`));
      const prioritized = [...suppressed].sort((a, b) =>
        Number(critical.has(`${b.fileId}:${b.findingId}`)) - Number(critical.has(`${a.fileId}:${a.findingId}`)));
      lines.push('', '**Unpublished findings** (full decisions in review artifacts):');
      for (const decision of prioritized.slice(0, 20)) {
        lines.push(`- \`${decision.fileId}:${decision.findingId}\` — ${decision.status}: ${decision.reason}`);
      }
      if (suppressed.length > 20) lines.push(`- …${suppressed.length - 20} more; inspect review.json.`);
    }
  }
  if (review.verdict.reasons.length > 0) {
    lines.push('', '**Verdict reasons:**');
    for (const reason of review.verdict.reasons.slice(0, 20)) lines.push(`- ${reason}`);
    if (review.verdict.reasons.length > 20) lines.push(`- …${review.verdict.reasons.length - 20} more reasons in review.json.`);
  }
  if (review.limitations.length > 0) {
    lines.push('', '**Coverage limitations:**');
    for (const limitation of review.limitations) {
      lines.push(`- ${limitation.required ? 'Required' : 'Advisory'} — ${limitation.message}`);
    }
  }
  if (review.files.length > 0) {
    lines.push('', '**Per file:**');
    for (const file of review.files.slice(0, 50)) {
      const findings = file.findingIds.length > 0 ? ` — ${file.findingIds.length} finding(s)` : '';
      const rejected = file.rejectedCandidates > 0 ? ` — ${file.rejectedCandidates} rejected candidate(s)` : '';
      lines.push(`- \`${escapeBackticks(file.path)}\`: ${file.outcome}${findings}${rejected}`);
    }
    if (review.files.length > 50) lines.push(`- …${review.files.length - 50} more file records in review.json.`);
  }
  lines.push('');
  lines.push(
    notes.publishedFileReviews > 0
      ? `**Publication:** ${notes.publishedFileReviews} file review${notes.publishedFileReviews === 1 ? '' : 's'} published.`
      : '**Publication:** no file reviews to publish.',
  );
  if (notes.failedFileReviews > 0 || notes.failedInlineComments > 0) {
    lines.push(
      `**Publication failures:** ${notes.failedFileReviews} file review${notes.failedFileReviews === 1 ? '' : 's'}, ${notes.failedInlineComments} inline comment${notes.failedInlineComments === 1 ? '' : 's'}. The full output is in the run artifacts.`,
    );
  }
  lines.push('', summaryMarker(scope));
  return lines.join('\n');
}
