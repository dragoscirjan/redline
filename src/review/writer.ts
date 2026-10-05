/**
 * Persists per-file review records and the run summary as JSON and Markdown
 * files in the output directory. The JSON files are the machine-readable
 * contract for later comment publication; the Markdown files are the
 * human-readable counterpart.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileReviewRecord, ReviewRunSummary, ValidatedFinding } from './types.js';

export const MAX_RAW_MODEL_OUTPUT_BYTES = 16 * 1024;

interface FileReviewRecordWithRaw extends FileReviewRecord {
  readonly rawModelOutput?: string | undefined;
}

function renderFindingMarkdown(finding: ValidatedFinding, index: number): string {
  return [
    `### Finding ${index + 1}: ${finding.severity} ${finding.classification} (${finding.category})`,
    '',
    `- **Location:** ${finding.side} line ${finding.line}`,
    `- **Confidence:** ${finding.confidence}`,
    `- **Evidence:** \`${finding.evidence.replace(/`/gu, '\\`')}\``,
    `- **Impact:** ${finding.impact}`,
    `- **Fix:** ${finding.fix}`,
    '',
  ].join('\n');
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
  ];
  if (record.reason !== undefined) lines.push(`- **Reason:** ${record.reason}`);
  if (record.errorKind !== undefined) lines.push(`- **Error kind:** ${record.errorKind}`);
  lines.push('', '');
  if (record.findings.length === 0) {
    lines.push(record.outcome === 'clean' ? 'No findings.' : 'No validated findings.');
  } else {
    lines.push(`## Findings (${record.findings.length})`, '');
    record.findings.forEach((finding, index) => {
      lines.push(renderFindingMarkdown(finding, index));
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
    '',
    '## Files',
    '',
    '| File | Outcome | Findings |',
    '| --- | --- | --- |',
  ];
  for (const file of summary.files) {
    lines.push(`| ${file.path} | ${file.outcome} | ${file.findingCount} |`);
  }
  return `${lines.join('\n')}\n`;
}

export interface ReviewWriter {
  writeFileReview(record: FileReviewRecord & { rawModelOutput?: string | undefined }): Promise<void>;
  writeSummary(summary: ReviewRunSummary): Promise<void>;
}

/**
 * Creates a writer bound to one output directory. Files are written under
 * the caller's output directory; the directory is created on first use.
 */
export function createReviewWriter(outputDirectory: string): ReviewWriter {
  const reviewsDirectory = join(outputDirectory, 'reviews');
  let prepared = false;
  const prepare = async (): Promise<void> => {
    if (!prepared) {
      await mkdir(reviewsDirectory, { recursive: true });
      prepared = true;
    }
  };
  return {
    async writeFileReview(record: FileReviewRecordWithRaw): Promise<void> {
      await prepare();
      const { rawModelOutput, ...rest } = record;
      const json: Record<string, unknown> = { ...rest };
      if (rawModelOutput !== undefined) {
        json['rawModelOutput'] =
          rawModelOutput.length > MAX_RAW_MODEL_OUTPUT_BYTES
            ? rawModelOutput.slice(0, MAX_RAW_MODEL_OUTPUT_BYTES)
            : rawModelOutput;
      }
      await writeFile(join(reviewsDirectory, `${record.fileId}.json`), `${JSON.stringify(json, null, 2)}\n`);
      await writeFile(join(reviewsDirectory, `${record.fileId}.md`), renderRecordMarkdown(record));
    },
    async writeSummary(summary: ReviewRunSummary): Promise<void> {
      await prepare();
      await writeFile(join(reviewsDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      await writeFile(join(reviewsDirectory, 'summary.md'), renderSummaryMarkdown(summary));
    },
  };
}
