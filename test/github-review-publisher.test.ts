import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubReviewPublisher } from '../src/github-review-publisher.js';
import type { ReviewRunScope } from '../src/review-journal.js';
import type { InlinePublication } from '../src/review-publication.js';

const HEAD = 'b'.repeat(40);
const SCOPE: ReviewRunScope = {
  runId: 'run-1',
  repository: 'owner/repository',
  pullRequest: 14,
  base: 'a'.repeat(40),
  head: HEAD,
  policyId: 'redline-review/v2',
  policyDigest: `sha256:${'c'.repeat(64)}`,
  reportStyle: 'inline',
};

interface ExpectedRequest {
  path: string;
  method: string;
  status?: number;
  body?: unknown;
  rawBody?: string;
  error?: Error;
}

function queuedFetch(expected: ExpectedRequest[]): { fetch: typeof fetch; requests: Array<{ url: string; init?: RequestInit }> } {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const implementation = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, ...(init ? { init } : {}) });
    const next = expected.shift();
    assert.ok(next, `unexpected request ${init?.method ?? 'GET'} ${url}`);
    assert.equal(new URL(url).pathname + new URL(url).search, next.path);
    assert.equal(init?.method, next.method);
    if (next.error) throw next.error;
    assert.ok(next.status);
    return new Response(next.rawBody ?? JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: implementation as typeof fetch, requests };
}

test('updates one actor-owned managed summary', async () => {
  const marker = '<!-- redline:summary:v1 repository=owner%2Frepository pr=14 -->';
  const queue = queuedFetch([
    { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
    {
      path: '/repos/owner/repository/issues/14/comments?per_page=100&page=1',
      method: 'GET',
      status: 200,
      body: [{ id: 9, body: `old\n${marker}`, user: { id: 7, login: 'redline-bot' } }],
    },
    {
      path: '/repos/owner/repository/issues/comments/9',
      method: 'PATCH',
      status: 200,
      body: { id: 9, body: `new\n${marker}`, user: { id: 7, login: 'redline-bot' } },
    },
  ]);
  const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
  assert.equal(await publisher.upsertSummary(SCOPE, `new\n${marker}`, marker), 9);
  assert.equal(queue.requests.length, 3);
  const headers = new Headers(queue.requests[0]?.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer secret');
});

test('returns an existing actor-owned inline comment without creating a duplicate', async () => {
  const marker = `<!-- redline:finding:v1 id=f-${'1'.repeat(24)} head=${HEAD} -->`;
  const queue = queuedFetch([
    { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
    {
      path: '/repos/owner/repository/pulls/14/comments?per_page=100&page=1',
      method: 'GET',
      status: 200,
      body: [{ id: 11, body: `finding\n${marker}`, commit_id: HEAD, user: { id: 7, login: 'redline-bot' } }],
    },
  ]);
  const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
  const publication: InlinePublication = {
    body: `finding\n${marker}`,
    marker,
    head: HEAD,
    path: 'src/example.ts',
    side: 'RIGHT',
    line: 1,
  };
  assert.equal(await publisher.publishInline(SCOPE, publication), 11);
  assert.equal(queue.requests.length, 2);
});

test('fails closed when summary ownership is ambiguous', async () => {
  const marker = '<!-- redline:summary:v1 repository=owner%2Frepository pr=14 -->';
  const owned = { body: `summary\n${marker}`, user: { id: 7, login: 'redline-bot' } };
  const queue = queuedFetch([
    { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
    {
      path: '/repos/owner/repository/issues/14/comments?per_page=100&page=1',
      method: 'GET',
      status: 200,
      body: [
        { id: 1, ...owned },
        { id: 2, ...owned },
      ],
    },
  ]);
  const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch });
  await assert.rejects(publisher.upsertSummary(SCOPE, `summary\n${marker}`, marker), /ownership is ambiguous/u);
});

test('re-lists by marker before retrying an uncertain inline creation', async () => {
  const marker = `<!-- redline:finding:v1 id=f-${'1'.repeat(24)} head=${HEAD} -->`;
  const existing = { id: 11, body: `finding\n${marker}`, commit_id: HEAD, user: { id: 7, login: 'redline-bot' } };
  const queue = queuedFetch([
    { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
    {
      path: '/repos/owner/repository/pulls/14/comments?per_page=100&page=1',
      method: 'GET',
      status: 200,
      body: [],
    },
    {
      path: '/repos/owner/repository/pulls/14/comments',
      method: 'POST',
      status: 503,
      body: { message: 'uncertain result' },
    },
    {
      path: '/repos/owner/repository/pulls/14/comments?per_page=100&page=1',
      method: 'GET',
      status: 200,
      body: [existing],
    },
  ]);
  const delays: number[] = [];
  const publisher = new GitHubReviewPublisher({
    token: 'secret',
    fetch: queue.fetch,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  assert.equal(
    await publisher.publishInline(SCOPE, {
      body: `finding\n${marker}`,
      marker,
      head: HEAD,
      path: 'src/example.ts',
      side: 'RIGHT',
      line: 1,
    }),
    11,
  );
  assert.deepEqual(delays, [100]);
});

test('reconciles an inline comment after a transport error', async () => {
  const marker = `<!-- redline:finding:v1 id=f-${'2'.repeat(24)} head=${HEAD} -->`;
  const existing = { id: 12, body: `finding\n${marker}`, commit_id: HEAD, user: { id: 7, login: 'redline-bot' } };
  const queue = queuedFetch([
    { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
    { path: '/repos/owner/repository/pulls/14/comments?per_page=100&page=1', method: 'GET', status: 200, body: [] },
    { path: '/repos/owner/repository/pulls/14/comments', method: 'POST', error: new Error('connection reset') },
    { path: '/repos/owner/repository/pulls/14/comments?per_page=100&page=1', method: 'GET', status: 200, body: [existing] },
  ]);
  const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch, sleep: async () => undefined });
  assert.equal(
    await publisher.publishInline(SCOPE, {
      body: `finding\n${marker}`,
      marker,
      head: HEAD,
      path: 'src/example.ts',
      side: 'RIGHT',
      line: 1,
    }),
    12,
  );
});

test('reconciles an inline comment after a malformed successful response', async () => {
  const marker = `<!-- redline:finding:v1 id=f-${'3'.repeat(24)} head=${HEAD} -->`;
  const existing = { id: 13, body: `finding\n${marker}`, commit_id: HEAD, user: { id: 7, login: 'redline-bot' } };
  const queue = queuedFetch([
    { path: '/user', method: 'GET', status: 200, body: { id: 7, login: 'redline-bot' } },
    { path: '/repos/owner/repository/pulls/14/comments?per_page=100&page=1', method: 'GET', status: 200, body: [] },
    { path: '/repos/owner/repository/pulls/14/comments', method: 'POST', status: 201, rawBody: '{not-json' },
    { path: '/repos/owner/repository/pulls/14/comments?per_page=100&page=1', method: 'GET', status: 200, body: [existing] },
  ]);
  const publisher = new GitHubReviewPublisher({ token: 'secret', fetch: queue.fetch, sleep: async () => undefined });
  assert.equal(
    await publisher.publishInline(SCOPE, {
      body: `finding\n${marker}`,
      marker,
      head: HEAD,
      path: 'src/example.ts',
      side: 'RIGHT',
      line: 1,
    }),
    13,
  );
});

test('retries bounded transient GitHub failures', async () => {
  const queue = queuedFetch([
    { path: '/repos/owner/repository/pulls/14', method: 'GET', status: 503, body: { message: 'retry' } },
    { path: '/repos/owner/repository/pulls/14', method: 'GET', status: 200, body: { head: { sha: HEAD } } },
  ]);
  const delays: number[] = [];
  const publisher = new GitHubReviewPublisher({
    token: 'secret',
    fetch: queue.fetch,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  assert.equal(await publisher.currentHead(SCOPE), HEAD);
  assert.deepEqual(delays, [100]);
});
