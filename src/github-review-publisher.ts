import { byteLength, isRecord } from './review-bundle.js';
import type { ReviewRunScope } from './review-journal.js';
import type { InlinePublication, ReviewForgePublisher } from './review-publication.js';

const API_ROOT = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_COMMENT_BYTES = 65_536;
const MAX_PAGES = 10;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

interface GitHubActor {
  id: number;
  login: string;
}

interface GitHubComment {
  id: number;
  body: string;
  user: GitHubActor;
  commit_id?: string;
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

class GitHubApiError extends Error {
  constructor(request: string, readonly status: number, detail?: string) {
    // GitHub error bodies carry the actionable reason (for example
    // "Resource not accessible by integration"); keep a bounded copy without
    // risking large or irrelevant payloads.
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

function repositoryParts(repository: string): { owner: string; name: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(repository);
  if (!match) throw new Error('repository must use owner/name syntax');
  return { owner: match[1] as string, name: match[2] as string };
}

function validateBody(body: string): void {
  if (byteLength(body) > MAX_COMMENT_BYTES) throw new Error('GitHub comment exceeds the byte limit');
}

export class GitHubReviewPublisher implements ReviewForgePublisher {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #actorPromise: Promise<GitHubActor> | undefined;

  constructor(input: {
    token: string;
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    if (input.token.length === 0) throw new Error('GitHub token is required');
    this.#token = input.token;
    this.#fetch = input.fetch ?? fetch;
    this.#sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async currentHead(scope: ReviewRunScope): Promise<string> {
    const { owner, name } = repositoryParts(scope.repository);
    const value = await this.#requestJson(`/repos/${owner}/${name}/pulls/${scope.pullRequest}`, { method: 'GET' }, [200]);
    if (!isRecord(value) || !isRecord(value.head) || typeof value.head.sha !== 'string') {
      throw new Error('GitHub pull request response has no head revision');
    }
    return value.head.sha;
  }

  async upsertSummary(scope: ReviewRunScope, body: string, marker: string): Promise<number> {
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

  async publishInline(scope: ReviewRunScope, publication: InlinePublication): Promise<number> {
    validateBody(publication.body);
    if (publication.head !== scope.head) throw new Error('inline publication head does not match the review scope');
    const actor = await this.#actor();
    const { owner, name } = repositoryParts(scope.repository);
    const findExisting = async (): Promise<GitHubComment | undefined> => {
      const comments = await this.#listComments(scope, 'pulls');
      const matches = comments.filter(
        (comment) =>
          comment.user.id === actor.id &&
          comment.commit_id === scope.head &&
          trailingMarker(comment.body, publication.marker),
      );
      if (matches.length > 1) throw new Error('managed inline finding ownership is ambiguous');
      return matches[0];
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await findExisting();
      if (existing) return existing.id;
      try {
        const value = await this.#requestJson(
          `/repos/${owner}/${name}/pulls/${scope.pullRequest}/comments`,
          {
            method: 'POST',
            body: JSON.stringify({
              body: publication.body,
              commit_id: scope.head,
              path: publication.path,
              side: publication.side,
              line: publication.line,
            }),
          },
          [201],
        );
        return parseComment(value, 'GitHub inline finding').id;
      } catch (error) {
        if (error instanceof GitHubApiError && !RETRYABLE_STATUSES.has(error.status)) throw error;
        await this.#sleep(100 * 2 ** attempt);
        const reconciled = await findExisting();
        if (reconciled) return reconciled.id;
        if (attempt === 2) throw error;
      }
    }
    throw new Error('GitHub inline finding creation failed');
  }

  async #actor(): Promise<GitHubActor> {
    this.#actorPromise ??= this.#requestJson('/user', { method: 'GET' }, [200]).then((value) =>
      parseActor(value, 'GitHub authenticated actor'),
    );
    return this.#actorPromise;
  }

  async #listComments(scope: ReviewRunScope, kind: 'issues' | 'pulls'): Promise<GitHubComment[]> {
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
    if (!response || !expectedStatuses.includes(response.status)) throw new Error('GitHub API request failed');
    const text = await response.text();
    if (byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('GitHub API response exceeds the byte limit');
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('GitHub API response is not valid JSON');
    }
  }
}
