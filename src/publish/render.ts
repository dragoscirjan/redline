/**
 * Renders the managed publication bodies.
 *
 * Every body ends with its machine-readable hidden marker so the publisher
 * can find, own, and deduplicate its objects. Finding text is model output;
 * it is embedded as quoted review data and never alters the structure.
 */

import { spanLocation } from '../review/remediation.js';
import type { FileReviewRecord, PublishedFinding, ReviewRunSummary } from '../review/types.js';
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
    `**${finding.severity} ${finding.classification} (${finding.category})** — \`${location}\` (side ${finding.side}), confidence ${finding.confidence}`,
    '',
    `- **Evidence (line ${finding.startLine}):** \`${escapeBackticks(finding.evidence)}\``,
    `- **Impact:** ${finding.impact}`,
    `- **Fix:** ${finding.fix}`,
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
    '',
    `Findings${spanList.length > 0 ? ` (${spanList})` : ''} are attached as inline comments with apply-able suggestions and fix prompts. All findings are validated against the reviewed diff before publication.`,
    '',
    fileReviewMarker(scope, record.fileId),
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
  summary: ReviewRunSummary,
  notes: SummaryPublicationNotes,
): string {
  const lines = [
    '## Redline review summary',
    '',
    `- **Revisions:** \`${summary.base.slice(0, 12)}\`…\`${summary.head.slice(0, 12)}\``,
    `- **Harness:** ${summary.harness} (${summary.provider}/${summary.model})`,
    `- **Finding scope:** ${summary.findingScope}`,
    `- **Files:** ${summary.manifestFiles} in the manifest · ${summary.reviewedFiles} reviewed · ${summary.omittedFiles} omitted`,
    `- **Findings:** ${summary.findings}`,
  ];
  if (summary.files.length > 0) {
    lines.push('', '**Per file:**');
    for (const file of summary.files) {
      const spans =
        file.findingSpans.length > 0 ? ` — ${file.findingSpans.map((span) => `\`${span}\``).join(', ')}` : '';
      const error = file.errorKind !== undefined ? ` (${file.errorKind})` : '';
      lines.push(`- \`${file.path}\`: ${file.outcome}${spans}${error}`);
    }
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
