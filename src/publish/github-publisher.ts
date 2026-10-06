/**
 * GitHub publisher: the forge adapter for the publication contracts.
 *
 * Ports the mechanics of the previous design's `github-review-publisher.ts`:
 * injectable fetch for contract tests, Bearer auth with pinned API version
 * headers, bounded response bodies, retry with backoff on transient
 * statuses, explicit actor resolution (PAT through `/user`; App
 * installation tokens through a configured bot login — nothing assumed),
 * pagination caps, marker-plus-author ownership checks that fail closed on
 * ambiguity, and POST-reconcile on uncertain creation. New in this design:
 * a file's review is published as one PR review (`POST /pulls/{n}/reviews`)
 * with its findings as inline comments.
 */

import { byteLength, isRecord } from '../review/bundle.js';
import type { FileReviewPublication, ReviewPublisher, ReviewScope } from './types.js';

const API_ROOT = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_COMMENT_BYTES = 65_536;
const MAX_PAGES = 10;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export interface GitHubActor {
  id: number;
  login: string;
}

interface GitHubComment {
  id: number;
  body: string;
  user: GitHubActor;
  commit_id?: string;
}

interface GitHubReview {
  id: number;
  body: string;
  user: GitHubActor;
}

async function boundedErrorBody(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length === 0) return undefined;
    return text.slice(0, 400).replaceAll(/[\u0000-\u001f]+/gu, ' ');
  } catch {
    return undefined;
  }
}

export class GitHubApiError extends Error {
  constructor(request: string, readonly status: number, detail?: string) {
    // GitHub error bodies carry the actionable reason (for example
    // "Resource not accessible by integration"); keep a bounded copy
    // without risking large or irrelevant payloads.
    const bounded = detail === undefined || detail.length === 0 ? '' : `: ${detail.slice(0, 400)}`;
    super(`GitHub API request failed (${request}) with status ${status}${bounded}`);
  }
}

function trailingMarker(body: string, marker: string): boolean {
  return body.trimEnd().split(/\r?\n/u).at(-1) === marker;
}

function parseActor(value: unknown, label: string): GitHubActor {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
    throw new Error(`${label} has an invalid actor id`);
  }
  if (typeof value.login !== 'string' || value.login.length === 0) throw new Error(`${label} has an invalid login`);
  return { id: value.id as number, login: value.login };
}

function parseComment(value: unknown, label: string): GitHubComment {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
    throw new Error(`${label} has an invalid comment id`);
  }
  if (typeof value.body !== 'string') throw new Error(`${label} has an invalid body`);
  const comment: GitHubComment = {
    id: value.id as number,
    body: value.body,
    user: parseActor(value.user, `${label}.user`),
  };
  if (value.commit_id !== undefined) {
    if (typeof value.commit_id !== 'string') throw new Error(`${label} has an invalid commit id`);
    comment.commit_id = value.commit_id;
  }
  return comment;
}

function parseReview(value: unknown, label: string): GitHubReview {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
    throw new Error(`${label} has an invalid review id`);
  }
  if (typeof value.body !== 'string') throw new Error(`${label} has an invalid body`);
  return {
    id: value.id as number,
    body: value.body,
    user: parseActor(value.user, `${label}.user`),
  };
}

function repositoryParts(repository: string): { owner: string; name: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(repository);
  if (!match) throw new Error('repository must use owner/name syntax');
  return { owner: match[1] as string, name: match[2] as string };
}

function validateBody(body: string): void {
  if (byteLength(body) > MAX_COMMENT_BYTES) throw new Error('GitHub comment exceeds the byte limit');
}

export interface GitHubReviewPublisherOptions {
  readonly token: string;
  /** Injectable fetch; contract tests queue scripted responses. */
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Bot login for GitHub App installation tokens, which have no user
   * behind `GET /user` and post as `<app-slug>[bot]`. When `/user` is
   * inaccessible, resolution uses this login and fails closed without
   * it — no built-in identity is assumed. A plain PAT never needs this.
   */
  readonly botLogin?: string;
}

export class GitHubReviewPublisher implements ReviewPublisher {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #botLogin: string | undefined;
  #actorPromise: Promise<GitHubActor> | undefined;

  constructor(options: GitHubReviewPublisherOptions) {
    if (options.token.length === 0) throw new Error('GitHub publisher requires a token');
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#botLogin = options.botLogin;
  }

  async currentHead(scope: ReviewScope): Promise<string> {
    const { owner, name } = repositoryParts(scope.repository);
    const value = await this.#requestJson(`/repos/${owner}/${name}/pulls/${scope.pullRequest}`, { method: 'GET' }, [200]);
    if (!isRecord(value) || !isRecord(value['head']) || typeof value['head']['sha'] !== 'string') {
      throw new Error('GitHub pull request response has no head revision');
    }
    return value['head']['sha'] as string;
  }

  async upsertSummary(scope: ReviewScope, body: string, marker: string): Promise<number> {
    validateBody(body);
    const actor = await this.#actor();
    const { owner, name } = repositoryParts(scope.repository);
    const findExisting = async (): Promise<GitHubComment | undefined> => {
      const comments = await this.#listComments(scope, 'issues');
      const matches = comments.filter((comment) => comment.user.id === actor.id && trailingMarker(comment.body, marker));
      if (matches.length > 1) throw new Error('managed summary ownership is ambiguous');
      return matches[0];
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await findExisting();
      if (existing) {
        const value = await this.#requestJson(
          `/repos/${owner}/${name}/issues/comments/${existing.id}`,
          { method: 'PATCH', body: JSON.stringify({ body }) },
          [200],
        );
        return parseComment(value, 'GitHub managed summary').id;
      }
      try {
        const value = await this.#requestJson(
          `/repos/${owner}/${name}/issues/${scope.pullRequest}/comments`,
          { method: 'POST', body: JSON.stringify({ body }) },
          [201],
        );
        return parseComment(value, 'GitHub managed summary').id;
      } catch (error) {
        if (error instanceof GitHubApiError && !RETRYABLE_STATUSES.has(error.status)) throw error;
        await this.#sleep(100 * 2 ** attempt);
        const reconciled = await findExisting();
        if (reconciled) return reconciled.id;
        if (attempt === 2) throw error;
      }
    }
    throw new Error('GitHub managed summary creation failed');
  }

  async publishFileReview(scope: ReviewScope, publication: FileReviewPublication): Promise<number> {
    validateBody(publication.body);
    if (publication.comments.length === 0) throw new Error('file review publication requires at least one inline comment');
    for (const comment of publication.comments) validateBody(comment.body);
    const actor = await this.#actor();
    const { owner, name } = repositoryParts(scope.repository);
    const findExisting = async (): Promise<GitHubReview | undefined> => {
      const reviews = await this.#listReviews(scope);
      const matches = reviews.filter((review) => review.user.id === actor.id && trailingMarker(review.body, publication.marker));
      if (matches.length > 1) throw new Error('managed file review ownership is ambiguous');
      return matches[0];
    };
    const existing = await findExisting();
    if (existing) return existing.id;
    try {
      const value = await this.#requestJson(
        `/repos/${owner}/${name}/pulls/${scope.pullRequest}/reviews`,
        {
          method: 'POST',
          body: JSON.stringify({
            commit_id: scope.head,
            body: publication.body,
            event: 'COMMENT',
            comments: publication.comments.map((comment) => ({
              path: comment.path,
              side: comment.side,
              line: comment.line,
              ...(comment.startLine !== undefined ? { start_line: comment.startLine } : {}),
              ...(comment.startSide !== undefined ? { start_side: comment.startSide } : {}),
              body: comment.body,
            })),
          }),
        },
        [200],
      );
      return parseReview(value, 'GitHub file review').id;
    } catch (error) {
      // POSTs are never retried at transport level: a 502/504 may have
      // created the review before the response was lost. Reconcile like
      // upsertSummary before reporting the failure.
      if (!(error instanceof GitHubApiError) || !RETRYABLE_STATUSES.has(error.status)) throw error;
      await this.#sleep(200);
      const reconciled = await findExisting();
      if (reconciled) return reconciled.id;
      throw error;
    }
  }

  async #actor(): Promise<GitHubActor> {
    this.#actorPromise ??= this.#resolveActor();
    return this.#actorPromise;
  }

  /**
   * A GitHub App installation token has no user behind it: `GET /user`
   * answers 403 with "Resource not accessible by integration". Comments
   * it posts are authored by the app's bot identity, so the caller must
   * configure that login explicitly (`botLogin`); nothing is assumed.
   * A plain PAT resolves through `/user`.
   */
  async #resolveActor(): Promise<GitHubActor> {
    let userError: GitHubApiError | undefined;
    try {
      return await this.#requestJson('/user', { method: 'GET' }, [200]).then((value) =>
        parseActor(value, 'GitHub authenticated actor'),
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 403) throw error;
      userError = error;
    }
    const botLogin = this.#botLogin;
    if (botLogin === undefined) throw userError;
    return await this.#requestJson(`/users/${encodeURIComponent(botLogin)}`, { method: 'GET' }, [200]).then((value) =>
      parseActor(value, 'configured bot actor'),
    );
  }

  async #listComments(scope: ReviewScope, kind: 'issues' | 'pulls'): Promise<GitHubComment[]> {
    const { owner, name } = repositoryParts(scope.repository);
    const comments: GitHubComment[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const value = await this.#requestJson(
        `/repos/${owner}/${name}/${kind}/${scope.pullRequest}/comments?per_page=100&page=${page}`,
        { method: 'GET' },
        [200],
      );
      if (!Array.isArray(value)) throw new Error('GitHub comments response must be an array');
      comments.push(...value.map((item, index) => parseComment(item, `GitHub comment ${index}`)));
      if (value.length < 100) return comments;
    }
    throw new Error('GitHub comments exceed the pagination limit');
  }

  async #listReviews(scope: ReviewScope): Promise<GitHubReview[]> {
    const { owner, name } = repositoryParts(scope.repository);
    const reviews: GitHubReview[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const value = await this.#requestJson(
        `/repos/${owner}/${name}/pulls/${scope.pullRequest}/reviews?per_page=100&page=${page}`,
        { method: 'GET' },
        [200],
      );
      if (!Array.isArray(value)) throw new Error('GitHub reviews response must be an array');
      reviews.push(...value.map((item, index) => parseReview(item, `GitHub review ${index}`)));
      if (value.length < 100) return reviews;
    }
    throw new Error('GitHub reviews exceed the pagination limit');
  }

  async #requestJson(path: string, init: RequestInit, expectedStatuses: readonly number[]): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${this.#token}`);
    headers.set('Content-Type', 'application/json');
    headers.set('User-Agent', 'redline-review');
    headers.set('X-GitHub-Api-Version', '2022-11-28');

    let response: Response | undefined;
    const retrySafe = init.method !== 'POST';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await this.#fetch(`${API_ROOT}${path}`, { ...init, headers });
      if (expectedStatuses.includes(response.status)) break;
      if (!retrySafe || !RETRYABLE_STATUSES.has(response.status) || attempt === 2) {
        throw new GitHubApiError(`${init.method ?? 'GET'} ${path}`, response.status, await boundedErrorBody(response));
      }
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      const delay = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1_000, 2_000) : 100 * 2 ** attempt;
      await this.#sleep(delay);
    }
    if (response === undefined || !expectedStatuses.includes(response.status)) {
      throw new GitHubApiError(`${init.method ?? 'GET'} ${path}`, response?.status ?? -1);
    }
    const text = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
    return JSON.parse(text) as unknown;
  }
}
