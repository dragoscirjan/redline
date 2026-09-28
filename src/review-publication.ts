import type { FindingReceipt, ReviewJournal, ReviewJournalSnapshot, ReviewRunScope } from './review-journal.js';
import {
  type ReviewCompletion,
  type ReviewCompletionEvent,
  type ReviewEvent,
  type ReviewFindingValidator,
  type ValidatedFinding,
  validateReviewCompletion,
} from './review-report.js';

export interface InlinePublication {
  body: string;
  marker: string;
  head: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
}

export interface ReviewForgePublisher {
  currentHead(scope: ReviewRunScope): Promise<string>;
  upsertSummary(scope: ReviewRunScope, body: string, marker: string): Promise<number>;
  publishInline(scope: ReviewRunScope, publication: InlinePublication): Promise<number>;
}

export type EventReceipt = FindingReceipt | { accepted: true; completion: true };

function summaryMarker(scope: ReviewRunScope): string {
  return `<!-- redline:summary:v1 repository=${encodeURIComponent(scope.repository)} pr=${scope.pullRequest} -->`;
}

function findingMarker(scope: ReviewRunScope, finding: ValidatedFinding): string {
  return `<!-- redline:finding:v1 id=${finding.id} head=${scope.head} -->`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(/([`*_{}[\]()#+.!|>~-])/gu, '\\$1');
}

function statusHeading(completion: ReviewCompletion, model: ReviewCompletionEvent | undefined): string {
  if (completion.status === 'incomplete' || model?.outcome === 'incomplete') return 'Review incomplete';
  if (model?.outcome === 'findings') return 'Review completed with findings';
  return 'Review completed';
}

function incompleteNotice(completion: ReviewCompletion): string {
  if (completion.status !== 'incomplete') return '';
  const reason = completion.reason as string;
  const message = completion.message
    ? escapeMarkdown(completion.message)
    : 'The review ended before complete coverage was confirmed. The report contains only findings validated before finalization.';
  return `\n> **Incomplete:** ${message}\n> Reason: \`${reason}\`\n`;
}

function counts(snapshot: ReviewJournalSnapshot): string {
  const accepted = snapshot.findings.length;
  const published = snapshot.published.size;
  const failed = snapshot.publicationFailures.size;
  const pending = Math.max(0, accepted - published - failed);
  return `Accepted: ${accepted}. Published inline: ${published}. Pending: ${pending}. Publication failures: ${failed}.`;
}

function coverageText(completion: ReviewCompletionEvent | undefined): string {
  if (!completion) return 'Coverage was not finalized.';
  const reviewed = completion.coverage.reviewedFileIds.length;
  const omitted = completion.coverage.omitted.length;
  const failures = completion.coverage.capabilityFailures.length;
  return `Reviewed files: ${reviewed}. Omitted files: ${omitted}. Capability failures: ${failures}.`;
}

function renderFinding(finding: ValidatedFinding, index: number): string {
  return [
    `### ${index}. ${finding.severity.toUpperCase()} ${escapeMarkdown(finding.category)} ${escapeMarkdown(finding.classification)}`,
    '',
    `Path: ${escapeMarkdown(finding.path)}. Line: ${finding.line}. Side: ${finding.side}.`,
    '',
    `    ${finding.evidence.replaceAll('\n', '\n    ')}`,
    '',
    `Impact: ${escapeMarkdown(finding.impact)}`,
    '',
    `Fix: ${escapeMarkdown(finding.fix)}`,
    '',
    `Confidence: ${finding.confidence.toFixed(2)}. Finding ID: \`${finding.id}\`.`,
  ].join('\n');
}

export function renderRunningSummary(scope: ReviewRunScope, startedAt: string): string {
  return [
    '## Redline review running',
    '',
    `Reviewing \`${scope.base}\` through \`${scope.head}\`.`,
    '',
    `Started at ${escapeMarkdown(startedAt)}. Reporting mode: \`${scope.reportStyle}\`.`,
    '',
    summaryMarker(scope),
  ].join('\n');
}

export function renderInlineFinding(scope: ReviewRunScope, finding: ValidatedFinding): InlinePublication {
  const marker = findingMarker(scope, finding);
  const body = [renderFinding(finding, 1).replace(/^### 1\. /u, '### '), '', marker].join('\n');
  return {
    body,
    marker,
    head: scope.head,
    path: finding.path,
    side: finding.side,
    line: finding.line,
  };
}

export function renderFinalSummary(snapshot: ReviewJournalSnapshot, completion: ReviewCompletion): string {
  const heading = statusHeading(completion, snapshot.completion);
  const body = [
    `## ${heading}`,
    incompleteNotice(completion),
    counts(snapshot),
    coverageText(snapshot.completion),
  ];
  if (snapshot.scope.reportStyle === 'single-block' && snapshot.findings.length > 0) {
    body.push('', ...snapshot.findings.map((finding, index) => renderFinding(finding, index + 1)));
  } else if (snapshot.scope.reportStyle === 'single-block') {
    body.push('', snapshot.completion?.outcome === 'clean' ? 'No validated findings.' : 'No finding was validated before finalization.');
  } else if (snapshot.publicationFailures.size > 0) {
    body.push('', 'Some validated inline findings could not be published. See the publication counts above.');
  } else {
    body.push('', 'Validated findings are attached to changed lines. This summary does not repeat them.');
  }
  body.push('', summaryMarker(snapshot.scope));
  return body.join('\n');
}

export class ReviewPublicationService {
  readonly #validator: ReviewFindingValidator;
  readonly #journal: ReviewJournal;
  readonly #publisher: ReviewForgePublisher;
  readonly #scope: ReviewRunScope;
  readonly #startedAt: string;

  constructor(input: {
    validator: ReviewFindingValidator;
    journal: ReviewJournal;
    publisher: ReviewForgePublisher;
    scope: ReviewRunScope;
    startedAt?: string;
  }) {
    this.#validator = input.validator;
    this.#journal = input.journal;
    this.#publisher = input.publisher;
    this.#scope = input.scope;
    this.#startedAt = input.startedAt ?? new Date().toISOString();
  }

  async initialize(): Promise<void> {
    await this.#assertCurrentHead();
    await this.#publisher.upsertSummary(
      this.#scope,
      renderRunningSummary(this.#scope, this.#startedAt),
      summaryMarker(this.#scope),
    );
  }

  async accept(event: ReviewEvent): Promise<EventReceipt> {
    if (event.type === 'completion') {
      const snapshot = this.#journal.snapshot();
      this.#validator.validateCompletion(event, snapshot.findings.length);
      await this.#journal.recordCompletion(event);
      return { accepted: true, completion: true };
    }

    const finding = this.#validator.validateFinding(event.finding);
    const receipt = await this.#journal.recordFinding(finding);
    if (!receipt.duplicate && this.#scope.reportStyle === 'inline') {
      await this.#publishInline(finding);
    }
    return receipt;
  }

  async finalize(completion: ReviewCompletion): Promise<void> {
    const validated = validateReviewCompletion(completion);
    const snapshot = this.#journal.snapshot();
    if (validated.status === 'complete' && !snapshot.completion) {
      throw new Error('complete finalization requires a model completion event');
    }
    if (validated.status === 'complete' && snapshot.publicationFailures.size > 0) {
      throw new Error('complete finalization cannot hide publication failures');
    }
    await this.#assertCurrentHead();
    await this.#publisher.upsertSummary(
      this.#scope,
      renderFinalSummary(snapshot, validated),
      summaryMarker(this.#scope),
    );
  }

  async #publishInline(finding: ValidatedFinding): Promise<void> {
    try {
      await this.#assertCurrentHead();
      const commentId = await this.#publisher.publishInline(this.#scope, renderInlineFinding(this.#scope, finding));
      await this.#journal.recordPublished(finding.id, commentId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown publication failure';
      await this.#journal.recordPublicationFailure(finding.id, reason.slice(0, 1_024));
    }
  }

  async #assertCurrentHead(): Promise<void> {
    const currentHead = await this.#publisher.currentHead(this.#scope);
    if (currentHead !== this.#scope.head) throw new Error('pull request head changed during review');
  }
}
