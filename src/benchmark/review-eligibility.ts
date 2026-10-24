import { readFile, writeFile } from 'node:fs/promises';

export const REVIEW_ELIGIBILITY_REPORT_VERSION = 1 as const;

interface ObservedFile {
  readonly path: string;
  readonly diffBytes: number;
  readonly modelDurationMs: number;
  readonly outcome: 'clean' | 'findings' | 'omitted';
  readonly findings: number;
  readonly rejectedCandidates: number;
}

interface ObservedClass {
  readonly id: string;
  readonly pattern: string;
  readonly candidateDefault: boolean;
  readonly files: readonly ObservedFile[];
}

interface EligibilityCapture {
  readonly version: 1;
  readonly kind: 'review-eligibility-observation';
  readonly capturedAt: string;
  readonly repository: string;
  readonly pullRequest: number;
  readonly runId: number;
  readonly runUrl: string;
  readonly head: string;
  readonly run: {
    readonly files: number;
    readonly diffBytes: number;
    readonly modelDurationMs: number;
    readonly findings: number;
    readonly omitted: number;
  };
  readonly classes: readonly ObservedClass[];
}

export interface ReviewEligibilityClassReport {
  readonly id: string;
  readonly pattern: string;
  readonly observedFiles: number;
  readonly diffBytes: number;
  readonly estimatedInputTokens: number;
  readonly modelDurationMs: number;
  readonly findings: number;
  readonly rejectedCandidates: number;
  readonly recommendation: 'exclude-by-default' | 'keep-reviewable' | 'insufficient-evidence';
  readonly reason: string;
}

export interface ReviewEligibilityReport {
  readonly version: typeof REVIEW_ELIGIBILITY_REPORT_VERSION;
  readonly kind: 'review-eligibility-value';
  readonly capturedAt: string;
  readonly source: {
    readonly repository: string;
    readonly pullRequest: number;
    readonly runId: number;
    readonly runUrl: string;
    readonly head: string;
  };
  readonly run: EligibilityCapture['run'];
  readonly classes: readonly ReviewEligibilityClassReport[];
  readonly selectedDefaults: readonly string[];
  readonly limitations: readonly string[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown key: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing key: ${key}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error(`${label} must be bounded text`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function parseFile(value: unknown, label: string): ObservedFile {
  const item = record(value, label);
  exactKeys(item, ['path', 'diffBytes', 'modelDurationMs', 'outcome', 'findings', 'rejectedCandidates'], label);
  const outcome = text(item.outcome, `${label}.outcome`);
  if (outcome !== 'clean' && outcome !== 'findings' && outcome !== 'omitted') throw new Error(`${label}.outcome is unsupported`);
  return {
    path: text(item.path, `${label}.path`),
    diffBytes: integer(item.diffBytes, `${label}.diffBytes`),
    modelDurationMs: integer(item.modelDurationMs, `${label}.modelDurationMs`),
    outcome,
    findings: integer(item.findings, `${label}.findings`),
    rejectedCandidates: integer(item.rejectedCandidates, `${label}.rejectedCandidates`),
  };
}

export function parseReviewEligibilityCapture(value: unknown): EligibilityCapture {
  const capture = record(value, 'capture');
  exactKeys(capture, ['version', 'kind', 'capturedAt', 'repository', 'pullRequest', 'runId', 'runUrl', 'head', 'run', 'classes'], 'capture');
  if (capture.version !== 1 || capture.kind !== 'review-eligibility-observation') throw new Error('capture identity is unsupported');
  const run = record(capture.run, 'capture.run');
  exactKeys(run, ['files', 'diffBytes', 'modelDurationMs', 'findings', 'omitted'], 'capture.run');
  if (!Array.isArray(capture.classes) || capture.classes.length > 16) throw new Error('capture.classes is invalid');
  const classes = capture.classes.map((value, index): ObservedClass => {
    const item = record(value, `capture.classes[${index}]`);
    exactKeys(item, ['id', 'pattern', 'candidateDefault', 'files'], `capture.classes[${index}]`);
    if (typeof item.candidateDefault !== 'boolean' || !Array.isArray(item.files) || item.files.length > 100) {
      throw new Error(`capture.classes[${index}] is invalid`);
    }
    return {
      id: text(item.id, `capture.classes[${index}].id`),
      pattern: text(item.pattern, `capture.classes[${index}].pattern`),
      candidateDefault: item.candidateDefault,
      files: item.files.map((file, fileIndex) => parseFile(file, `capture.classes[${index}].files[${fileIndex}]`)),
    };
  });
  return {
    version: 1,
    kind: 'review-eligibility-observation',
    capturedAt: text(capture.capturedAt, 'capture.capturedAt'),
    repository: text(capture.repository, 'capture.repository'),
    pullRequest: integer(capture.pullRequest, 'capture.pullRequest'),
    runId: integer(capture.runId, 'capture.runId'),
    runUrl: text(capture.runUrl, 'capture.runUrl'),
    head: text(capture.head, 'capture.head'),
    run: {
      files: integer(run.files, 'capture.run.files'),
      diffBytes: integer(run.diffBytes, 'capture.run.diffBytes'),
      modelDurationMs: integer(run.modelDurationMs, 'capture.run.modelDurationMs'),
      findings: integer(run.findings, 'capture.run.findings'),
      omitted: integer(run.omitted, 'capture.run.omitted'),
    },
    classes,
  };
}

function classReport(item: ObservedClass): ReviewEligibilityClassReport {
  const diffBytes = item.files.reduce((total, file) => total + file.diffBytes, 0);
  const modelDurationMs = item.files.reduce((total, file) => total + file.modelDurationMs, 0);
  const findings = item.files.reduce((total, file) => total + file.findings, 0);
  const rejectedCandidates = item.files.reduce((total, file) => total + file.rejectedCandidates, 0);
  if (item.files.length === 0) {
    return {
      id: item.id,
      pattern: item.pattern,
      observedFiles: 0,
      diffBytes: 0,
      estimatedInputTokens: 0,
      modelDurationMs: 0,
      findings: 0,
      rejectedCandidates: 0,
      recommendation: 'insufficient-evidence',
      reason: 'No files in this class were observed in the capture, so no default exclusion is justified.',
    };
  }
  const exclude = item.candidateDefault
    && item.files.every((file) => file.outcome === 'clean')
    && findings === 0
    && rejectedCandidates === 0;
  return {
    id: item.id,
    pattern: item.pattern,
    observedFiles: item.files.length,
    diffBytes,
    estimatedInputTokens: Math.ceil(diffBytes / 4),
    modelDurationMs,
    findings,
    rejectedCandidates,
    recommendation: exclude ? 'exclude-by-default' : 'keep-reviewable',
    reason: exclude
      ? 'Observed raw generated data consumed prompt and model budget without findings or rejected candidates.'
      : 'The class is review-relevant or lacks enough evidence for a default exclusion.',
  };
}

export function buildReviewEligibilityReport(capture: EligibilityCapture): ReviewEligibilityReport {
  const classes = capture.classes.map(classReport);
  return {
    version: REVIEW_ELIGIBILITY_REPORT_VERSION,
    kind: 'review-eligibility-value',
    capturedAt: capture.capturedAt,
    source: {
      repository: capture.repository,
      pullRequest: capture.pullRequest,
      runId: capture.runId,
      runUrl: capture.runUrl,
      head: capture.head,
    },
    run: capture.run,
    classes,
    selectedDefaults: classes.filter((item) => item.recommendation === 'exclude-by-default').map((item) => item.pattern),
    limitations: [
      'The live observation covers one Redline pull request and one model/provider configuration.',
      'Model duration is scheduling-dependent; diff bytes and estimated input tokens are deterministic for the captured change.',
      'Generated snapshots were not observed, so snapshot patterns remain configurable rather than enabled by default.',
      'Benchmark reports remain reviewable because they summarize policy conclusions; only raw capture data is excluded by default.',
    ],
  };
}

export function renderReviewEligibilityReport(report: ReviewEligibilityReport): string {
  const lines = [
    '# Review eligibility evidence',
    '',
    `- Source: [PR #${report.source.pullRequest} run ${report.source.runId}](${report.source.runUrl})`,
    `- Head: \`${report.source.head.slice(0, 12)}\``,
    `- Run: ${report.run.files} files, ${report.run.diffBytes.toLocaleString('en-US')} diff bytes, ${report.run.modelDurationMs.toLocaleString('en-US')} ms model work`,
    `- Selected default patterns: ${report.selectedDefaults.length === 0 ? 'none' : report.selectedDefaults.map((item) => `\`${item}\``).join(', ')}`,
    '',
    '| Class | Pattern | Files | Diff bytes | Estimated input tokens | Model ms | Findings | Recommendation |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const item of report.classes) {
    lines.push(`| ${item.id} | \`${item.pattern}\` | ${item.observedFiles} | ${item.diffBytes} | ${item.estimatedInputTokens} | ${item.modelDurationMs} | ${item.findings} | ${item.recommendation} |`);
  }
  lines.push('', '## Rationale', '');
  for (const item of report.classes) lines.push(`- **${item.id}:** ${item.reason}`);
  lines.push('', '## Limitations', '', ...report.limitations.map((item) => `- ${item}`));
  return `${lines.join('\n')}\n`;
}

export async function generateReviewEligibilityReport(
  capturePath: string,
  jsonPath: string,
  markdownPath: string,
): Promise<ReviewEligibilityReport> {
  const capture = parseReviewEligibilityCapture(JSON.parse(await readFile(capturePath, 'utf8')) as unknown);
  const report = buildReviewEligibilityReport(capture);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(markdownPath, renderReviewEligibilityReport(report)),
  ]);
  return report;
}
