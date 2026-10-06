import { describe, expect, it } from 'vitest';
import { GitHubReviewPublisher } from '../../src/publish/github-publisher.js';
import type { FileReviewPublication, ReviewScope } from '../../src/publish/types.js';

const HEAD = 'b'.repeat(40);
const SCOPE: ReviewScope = { repository: 'owner/repository', pullRequest: 14, head: HEAD };

const SUMMARY_MARKER = `<!-- redline:summary:v2 repository=owner%2Frepository pr=14 -->`;
const FILE_MARKER = `<!-- redline:file:v1 file=000001 head=${HEAD} -->`;

interface ExpectedRequest {
  path: string;
  method: string;
  status?: number;
  body?: unknown;
  error?: Error;
}

/** Queues scripted responses; asserts every request against the queue. */
function queuedFetch(expected: ExpectedRequest[]): {
  fetch: typeof fetch;
  requests: Array<{ url: string; init?: RequestInit }>;
} {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const implementation = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, ...(init ? { init } : {}) });
    const next = expected.shift();
    if (!next) throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    expect(new URL(url).pathname + new URL(url).search).toBe(next.path);
    expect(init?.method).toBe(next.method);
    if (next.error) throw next.error;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: implementation as typeof fetch, requests };
}

function filePublication(overrides: Partial<FileReviewPublication> = {}): FileReviewPublication {
  return {
    fileId: '000001',
    path: 'src/example.ts',
    body: `## Redline review: src/example.ts\n\n${FILE_MARKER}`,
    marker: FILE_MARKER,
    comments: [
      {
        path: 'src/example.ts',
        side: 'RIGHT',
        line: 1,
        body: `**high defect (correctness)**\n\n<!-- redline:finding:v1 id=f-abc head=${HEAD} -->`,
      },
    ],
    ...overrides,
  };
}

describe('GitHubReviewPublisher', () => {
  it('reads the current pull request head', async () => {
    const queue = queuedFetch([
      { path: '/repos/owner/repository/pulls/14', method: 'GET', status: 200, body: { head: { sha: HEAD } } },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
    await expect(publisher.currentHead(SCOPE)).resolves.toBe(HEAD);
    const headers = new Headers(queue.requests[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer secret');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
  });

  it('creates the managed summary when none exists', async () => {
    const queue = queuedFetch([
      { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
      {
        path: '/repos/owner/repository/issues/14/comments?per_page=100&page=1',
        method: 'GET',
        status: 200,
        body: [],
      },
      {
        path: '/repos/owner/repository/issues/14/comments',
        method: 'POST',
        status: 201,
        body: { id: 9, body: 'summary', user: { id: 7, login: 'redline-bot' } },
      },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
    await expect(publisher.upsertSummary(SCOPE, `summary\n${SUMMARY_MARKER}`, SUMMARY_MARKER)).resolves.toBe(9);
    expect(queue.requests.length).toBe(3);
  });

  it('updates one actor-owned managed summary', async () => {
    const queue = queuedFetch([
      { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
      {
        path: '/repos/owner/repository/issues/14/comments?per_page=100&page=1',
        method: 'GET',
        status: 200,
        body: [{ id: 9, body: `old\n${SUMMARY_MARKER}`, user: { id: 7, login: 'redline-bot' } }],
      },
      {
        path: '/repos/owner/repository/issues/comments/9',
        method: 'PATCH',
        status: 200,
        body: { id: 9, body: `new\n${SUMMARY_MARKER}`, user: { id: 7, login: 'redline-bot' } },
      },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
    await expect(publisher.upsertSummary(SCOPE, `new\n${SUMMARY_MARKER}`, SUMMARY_MARKER)).resolves.toBe(9);
    expect(queue.requests.length).toBe(3);
  });

  it('ignores summaries owned by other authors', async () => {
    const queue = queuedFetch([
      { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
      {
        path: '/repos/owner/repository/issues/14/comments?per_page=100&page=1',
        method: 'GET',
        status: 200,
        body: [{ id: 3, body: `not ours\n${SUMMARY_MARKER}`, user: { id: 8, login: 'someone-else' } }],
      },
      {
        path: '/repos/owner/repository/issues/14/comments',
        method: 'POST',
        status: 201,
        body: { id: 9, body: 'new', user: { id: 7, login: 'redline-bot' } },
      },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
    await expect(publisher.upsertSummary(SCOPE, `new\n${SUMMARY_MARKER}`, SUMMARY_MARKER)).resolves.toBe(9);
  });

  it('resolves a configured bot actor for App installation tokens', async () => {
    const queue = queuedFetch([
      {
        path: '/user',
        method: 'GET',
        status: 403,
        body: { message: 'Resource not accessible by integration', status: '403' },
      },
      {
        path: '/users/my-app%5Bbot%5D',
        method: 'GET',
        status: 200,
        body: { id: 901, login: 'my-app[bot]' },
      },
      {
        path: '/repos/owner/repository/issues/14/comments?per_page=100&page=1',
        method: 'GET',
        status: 200,
        body: [{ id: 9, body: `old\n${SUMMARY_MARKER}`, user: { id: 901, login: 'my-app[bot]' } }],
      },
      {
        path: '/repos/owner/repository/issues/comments/9',
        method: 'PATCH',
        status: 200,
        body: { id: 9, body: `summary\n${SUMMARY_MARKER}`, user: { id: 901, login: 'my-app[bot]' } },
      },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'token', fetch: queue.fetch, botLogin: 'my-app[bot]' });
    await expect(publisher.upsertSummary(SCOPE, `summary\n${SUMMARY_MARKER}`, SUMMARY_MARKER)).resolves.toBe(9);
    expect(queue.requests.length).toBe(4);
  });

  it('fails closed on an inaccessible /user without a configured bot login', async () => {
    const queue = queuedFetch([
      {
        path: '/user',
        method: 'GET',
        status: 403,
        body: { message: 'Resource not accessible by integration', status: '403' },
      },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'token', fetch: queue.fetch });
    await expect(publisher.upsertSummary(SCOPE, `summary\n${SUMMARY_MARKER}`, SUMMARY_MARKER)).rejects.toThrow(
      /status 403/u,
    );
  });

  it('fails closed when summary ownership is ambiguous', async () => {
    const queue = queuedFetch([
      { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
      {
        path: '/repos/owner/repository/issues/14/comments?per_page=100&page=1',
        method: 'GET',
        status: 200,
        body: [
          { id: 1, body: `summary\n${SUMMARY_MARKER}`, user: { id: 7, login: 'redline-bot' } },
          { id: 2, body: `summary\n${SUMMARY_MARKER}`, user: { id: 7, login: 'redline-bot' } },
        ],
      },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
    await expect(publisher.upsertSummary(SCOPE, `summary\n${SUMMARY_MARKER}`, SUMMARY_MARKER)).rejects.toThrow(
      /ownership is ambiguous/u,
    );
  });

  it('publishes a file review with inline comments bound to the reviewed head', async () => {
    const queue = queuedFetch([
      { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
      {
        path: '/repos/owner/repository/pulls/14/reviews?per_page=100&page=1',
        method: 'GET',
        status: 200,
        body: [],
      },
      {
        path: '/repos/owner/repository/pulls/14/reviews',
        method: 'POST',
        status: 200,
        body: { id: 31, body: 'review', user: { id: 7, login: 'redline-bot' } },
      },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
    await expect(publisher.publishFileReview(SCOPE, filePublication())).resolves.toBe(31);
    const request = JSON.parse(String(queue.requests[2]?.init?.body)) as {
      commit_id: string;
      event: string;
      body: string;
      comments: Array<{ path: string; side: string; line: number; body: string }>;
    };
    expect(request.commit_id).toBe(HEAD);
    expect(request.event).toBe('COMMENT');
    expect(request.body).toContain(FILE_MARKER);
    expect(request.comments[0]).toMatchObject({ path: 'src/example.ts', side: 'RIGHT', line: 1 });
    expect(request.comments[0]).not.toHaveProperty('start_line');
  });

  it('anchors multi-line comments to the full span', async () => {
    const queue = queuedFetch([
      { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
      { path: '/repos/owner/repository/pulls/14/reviews?per_page=100&page=1', method: 'GET', status: 200, body: [] },
      { path: '/repos/owner/repository/pulls/14/reviews', method: 'POST', status: 200, body: { id: 32, body: 'r', user: { id: 7, login: 'redline-bot' } } },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
    const publication = filePublication({
      comments: [
        { path: 'src/example.ts', side: 'RIGHT', line: 5, startLine: 3, startSide: 'RIGHT', body: 'multi-line finding' },
      ],
    });
    await publisher.publishFileReview(SCOPE, publication);
    const request = JSON.parse(String(queue.requests[2]?.init?.body)) as {
      comments: Array<{ line: number; start_line?: number; start_side?: string }>;
    };
    expect(request.comments[0]).toMatchObject({ line: 5, start_line: 3, start_side: 'RIGHT' });
  });

  it('reconciles an uncertain review POST instead of failing', async () => {
    const queue = queuedFetch([
      { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
      { path: '/repos/owner/repository/pulls/14/reviews?per_page=100&page=1', method: 'GET', status: 200, body: [] },
      { path: '/repos/owner/repository/pulls/14/reviews', method: 'POST', status: 502, body: { message: 'server error' } },
      {
        path: '/repos/owner/repository/pulls/14/reviews?per_page=100&page=1',
        method: 'GET',
        status: 200,
        body: [{ id: 33, body: `review\n${FILE_MARKER}`, user: { id: 7, login: 'redline-bot' } }],
      },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch, sleep: async () => {} });
    await expect(publisher.publishFileReview(SCOPE, filePublication())).resolves.toBe(33);
    expect(queue.requests.length).toBe(4);
  });

  it('keeps failing when the uncertain POST created nothing', async () => {
    const queue = queuedFetch([
      { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
      { path: '/repos/owner/repository/pulls/14/reviews?per_page=100&page=1', method: 'GET', status: 200, body: [] },
      { path: '/repos/owner/repository/pulls/14/reviews', method: 'POST', status: 502, body: { message: 'server error' } },
      { path: '/repos/owner/repository/pulls/14/reviews?per_page=100&page=1', method: 'GET', status: 200, body: [] },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch, sleep: async () => {} });
    await expect(publisher.publishFileReview(SCOPE, filePublication())).rejects.toThrow(/status 502/u);
  });

  it('returns the existing actor-owned file review without duplicating it', async () => {
    const queue = queuedFetch([
      { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
      {
        path: '/repos/owner/repository/pulls/14/reviews?per_page=100&page=1',
        method: 'GET',
        status: 200,
        body: [{ id: 31, body: `## Redline review: src/example.ts\n\n${FILE_MARKER}`, user: { id: 7, login: 'redline-bot' } }],
      },
    ]);
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
    await expect(publisher.publishFileReview(SCOPE, filePublication())).resolves.toBe(31);
    expect(queue.requests.length).toBe(2);
  });

  it('rejects a file review publication without inline comments', async () => {
    const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queuedFetch([]).fetch });
    await expect(publisher.publishFileReview(SCOPE, filePublication({ comments: [] }))).rejects.toThrow(
      /at least one inline comment/u,
    );
  });

  it('requires a token', () => {
    expect(() => new GitHubReviewPublisher({ token: '' })).toThrow(/requires a token/u);
  });
});
