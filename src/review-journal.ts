import { open, type FileHandle } from 'node:fs/promises';
import { byteLength } from './review-bundle.js';
import {
  MAX_REVIEW_FINDINGS,
  type ReviewCompletionEvent,
  type ValidatedFinding,
} from './review-report.js';
import type { ReportStyle } from './review-prompt.js';

const JOURNAL_VERSION = 1 as const;
const MAX_JOURNAL_BYTES = 512 * 1024;

export interface ReviewRunScope {
  runId: string;
  repository: string;
  pullRequest: number;
  base: string;
  head: string;
  policyId: string;
  policyDigest: string;
  reportStyle: ReportStyle;
}

export interface ReviewJournalSnapshot {
  scope: ReviewRunScope;
  findings: ValidatedFinding[];
  published: ReadonlyMap<string, number>;
  publicationFailures: ReadonlyMap<string, string>;
  completion: ReviewCompletionEvent | undefined;
}

export interface FindingReceipt {
  accepted: true;
  id: string;
  duplicate: boolean;
}

export class ReviewJournal {
  readonly #handle: FileHandle;
  readonly #scope: ReviewRunScope;
  readonly #findings = new Map<string, ValidatedFinding>();
  readonly #published = new Map<string, number>();
  readonly #publicationFailures = new Map<string, string>();
  #completion: ReviewCompletionEvent | undefined;
  #bytes = 0;
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown;
  #closed = false;

  private constructor(handle: FileHandle, scope: ReviewRunScope) {
    this.#handle = handle;
    this.#scope = scope;
  }

  static async create(path: string, scope: ReviewRunScope): Promise<ReviewJournal> {
    const handle = await open(path, 'wx', 0o600);
    const journal = new ReviewJournal(handle, scope);
    try {
      await journal.#append({ version: JOURNAL_VERSION, type: 'run', scope });
      return journal;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  recordFinding(finding: ValidatedFinding): Promise<FindingReceipt> {
    return this.#enqueue(async () => {
      this.#assertHealthy();
      const existing = this.#findings.get(finding.id);
      if (existing) return { accepted: true, id: finding.id, duplicate: true };
      if (this.#findings.size >= MAX_REVIEW_FINDINGS) throw new Error('review journal exceeds the finding limit');
      await this.#append({ version: JOURNAL_VERSION, type: 'finding-accepted', finding });
      this.#findings.set(finding.id, finding);
      return { accepted: true, id: finding.id, duplicate: false };
    });
  }

  recordPublished(findingId: string, commentId: number): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertHealthy();
      if (!this.#findings.has(findingId)) throw new Error('cannot publish a finding that is not accepted');
      if (!Number.isSafeInteger(commentId) || commentId <= 0) throw new Error('published comment id must be positive');
      const existing = this.#published.get(findingId);
      if (existing !== undefined) {
        if (existing !== commentId) throw new Error('finding publication comment id changed');
        return;
      }
      await this.#append({ version: JOURNAL_VERSION, type: 'finding-published', findingId, commentId });
      this.#published.set(findingId, commentId);
      this.#publicationFailures.delete(findingId);
    });
  }

  recordPublicationFailure(findingId: string, reason: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertHealthy();
      if (!this.#findings.has(findingId)) throw new Error('cannot fail a finding that is not accepted');
      if (reason.length === 0 || byteLength(reason) > 1_024) throw new Error('publication failure reason is invalid');
      await this.#append({ version: JOURNAL_VERSION, type: 'finding-publication-failed', findingId, reason });
      this.#publicationFailures.set(findingId, reason);
    });
  }

  recordCompletion(completion: ReviewCompletionEvent): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertHealthy();
      if (this.#completion) throw new Error('review journal already has a completion event');
      await this.#append({ version: JOURNAL_VERSION, type: 'review-completed', completion });
      this.#completion = completion;
    });
  }

  snapshot(): ReviewJournalSnapshot {
    return {
      scope: { ...this.#scope },
      findings: [...this.#findings.values()].map((finding) => ({ ...finding })),
      published: new Map(this.#published),
      publicationFailures: new Map(this.#publicationFailures),
      completion: this.#completion,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#tail;
    this.#closed = true;
    const failure = this.#failure;
    try {
      await this.#handle.close();
    } catch (error) {
      if (failure === undefined) throw error;
    }
    if (failure !== undefined) throw failure;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertHealthy(): void {
    if (this.#closed) throw new Error('review journal is closed');
    if (this.#failure !== undefined) throw this.#failure;
  }

  async #append(event: unknown): Promise<void> {
    this.#assertHealthy();
    const line = `${JSON.stringify(event)}\n`;
    const bytes = byteLength(line);
    if (this.#bytes + bytes > MAX_JOURNAL_BYTES) throw new Error('review journal exceeds its byte limit');
    try {
      await this.#handle.appendFile(line, 'utf8');
      await this.#handle.sync();
      this.#bytes += bytes;
    } catch (error) {
      this.#failure = error;
      throw error;
    }
  }
}
