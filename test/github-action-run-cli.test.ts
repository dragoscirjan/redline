import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { BackendExit, BackendReporting, ReviewBackendLauncher, RunningReviewBackend } from '../src/backend-process.js';
import {
  assertKnownEnvironment,
  executeAction,
  parseActionEnvironment,
  type ActionEnvironment,
} from '../src/github-action-run-cli.js';
import type { InlinePublication, ReviewForgePublisher } from '../src/review-publication.js';
import type { ReviewCompletionEvent, ReviewFindingEvent } from '../src/review-report.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MODEL_CONFIG = JSON.stringify({
  provider: 'openrouter',
  endpoint: 'https://openrouter.ai/api/v1',
  model: 'provider/model-name',
});
const RUNNER_IMAGE = 'ghcr.io/dragoscirjan/redline-pi@sha256:' + 'a'.repeat(64);
const executeFile = promisify(execFile);

function validEnvironment(overrides: Partial<ActionEnvironment> = {}): ActionEnvironment {
  return {
    githubToken: 'token-sentinel',
    backend: 'pi',
    modelConfig: MODEL_CONFIG,
    modelAuth: JSON.stringify({ openrouter: 'selected-secret' }),
    findingScope: '',
    reportStyle: '',
    timeout: '',
    credentialIsolation: 'direct',
    runnerImage: RUNNER_IMAGE,
    containerEngine: 'podman',
    artifactName: 'redline-review-1',
    artifactRetentionDays: '',
    reviewDirectory: '/tmp/review',
    sourceDirectory: '/tmp/source-at-head',
    journalPath: '/tmp/redline-journal/journal.jsonl',
    runId: '1234567890',
    repository: 'dragoscirjan/redline',
    pullRequest: '7',
    base: BASE,
    head: HEAD,
    ...overrides,
  };
}

function contextOnlyEnvironment(overrides: Partial<ActionEnvironment> = {}): ActionEnvironment {
  const { backend, modelConfig, modelAuth, runnerImage, ...rest } = validEnvironment(overrides);
  void backend;
  void modelConfig;
  void modelAuth;
  void runnerImage;
  return { ...rest, backend: '', modelConfig: '', modelAuth: '', runnerImage: '' };
}

function thrownMessage(callback: () => unknown): string {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  return caught.message;
}

test('parses the full action environment into a review-mode result', () => {
  const parsed = parseActionEnvironment(validEnvironment());
  assert.equal(parsed.mode, 'review');
  if (parsed.mode !== 'review') return;
  assert.equal(parsed.parsed.configuration.backend, 'pi');
  assert.deepEqual(parsed.identity, {
    runId: '1234567890',
    repository: 'dragoscirjan/redline',
    pullRequest: 7,
    base: BASE,
    head: HEAD,
    reportStyle: 'single-block',
  });
  assert.equal(parsed.reviewDirectory, '/tmp/review');
  assert.equal(parsed.journalPath, '/tmp/redline-journal/journal.jsonl');
  assert.equal(parsed.parsed.timeout.milliseconds, 1_800_000);
  assert.equal(Object.isFrozen(parsed.parsed), true);
});

test('normalizes upper-case revisions to lowercase full object ids', () => {
  const parsed = parseActionEnvironment(validEnvironment({ base: 'A'.repeat(40), head: 'B'.repeat(40) }));
  if (parsed.mode !== 'review') throw new Error('expected review mode');
  assert.equal(parsed.identity.base, 'a'.repeat(40));
  assert.equal(parsed.identity.head, 'b'.repeat(40));
});

test('returns context-only mode when no review inputs are supplied', () => {
  const parsed = parseActionEnvironment(contextOnlyEnvironment());
  assert.equal(parsed.mode, 'context-only');
  if (parsed.mode !== 'context-only') return;
  assert.equal(parsed.inputs.timeout.minutes, 30);
  assert.equal(parsed.inputs.artifactRetentionDays, 45);
  assert.equal(parsed.inputs.containerEngine, 'podman');
});

test('validates optional inputs in context-only mode', () => {
  assert.throws(() => parseActionEnvironment(contextOnlyEnvironment({ findingScope: 'everything' })));
  assert.throws(() => parseActionEnvironment(contextOnlyEnvironment({ timeout: '1d' })));
  assert.throws(() => parseActionEnvironment(contextOnlyEnvironment({ containerEngine: 'nerdctl' })));
  assert.match(
    thrownMessage(() => parseActionEnvironment(contextOnlyEnvironment({ credentialIsolation: 'gateway' }))),
    /credential-isolation is unsupported/u,
  );
});

test('rejects partial review selections', () => {
  const partial = { ...validEnvironment({ modelAuth: '' }) };
  const message = thrownMessage(() => parseActionEnvironment(partial));
  assert.match(message, /requires backend, model-config, model-auth, and runner-image together/u);
});

test('rejects a missing GitHub token', () => {
  assert.match(thrownMessage(() => parseActionEnvironment(validEnvironment({ githubToken: '' }))), /GH_TOKEN is required/u);
});

test('rejects missing or invalid action inputs with named variables', () => {
  const missing = { ...validEnvironment(), backend: undefined } as unknown as ActionEnvironment;
  assert.match(thrownMessage(() => parseActionEnvironment(missing)), /REDLINE_BACKEND is required/u);
  assert.match(
    thrownMessage(() => parseActionEnvironment(validEnvironment({ pullRequest: 'not-a-number' }))),
    /pull request number must be a positive integer/u,
  );
  assert.match(
    thrownMessage(() => parseActionEnvironment(validEnvironment({ timeout: '1d' }))),
    /exceeds the 360-minute cap/u,
  );
});

test('rejects NUL bytes in environment values', () => {
  assert.throws(() => parseActionEnvironment(validEnvironment({ repository: 'owner/repo\u0000suffix' })));
});

test('rejects unknown REDLINE_ environment variables but accepts known ones', () => {
  assert.doesNotThrow(() => assertKnownEnvironment({ REDLINE_BACKEND: 'pi' }));
  assert.match(
    thrownMessage(() => assertKnownEnvironment({ REDLINE_REVIEW_INSTRUCTIONS: 'https://example.test/attack' })),
    /unknown environment variable: REDLINE_REVIEW_INSTRUCTIONS/u,
  );
  assert.doesNotThrow(() => assertKnownEnvironment({ GH_TOKEN: 'x', PATH: '/bin' }));
});

function processEnvironment(environment: ActionEnvironment): NodeJS.ProcessEnv {
  return {
    GH_TOKEN: environment.githubToken,
    REDLINE_BACKEND: environment.backend,
    REDLINE_MODEL_CONFIG: environment.modelConfig,
    REDLINE_MODEL_AUTH: environment.modelAuth,
    REDLINE_FINDING_SCOPE: environment.findingScope,
    REDLINE_REPORT_STYLE: environment.reportStyle,
    REDLINE_TIMEOUT: environment.timeout,
    REDLINE_CREDENTIAL_ISOLATION: environment.credentialIsolation,
    REDLINE_RUNNER_IMAGE: environment.runnerImage,
    REDLINE_CONTAINER_ENGINE: environment.containerEngine,
    REDLINE_ARTIFACT_NAME: environment.artifactName,
    REDLINE_ARTIFACT_RETENTION_DAYS: environment.artifactRetentionDays,
    REDLINE_REVIEW_DIR: environment.reviewDirectory,
    REDLINE_SOURCE_DIR: environment.sourceDirectory,
    REDLINE_JOURNAL_PATH: environment.journalPath,
    REDLINE_RUN_ID: environment.runId,
    REDLINE_REPOSITORY: environment.repository,
    REDLINE_PULL_REQUEST: environment.pullRequest,
    REDLINE_BASE: environment.base,
    REDLINE_HEAD: environment.head,
  } as NodeJS.ProcessEnv;
}

// --- Controlled execution path ---

function piDelta(text: string): string {
  return JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
}

function findingEvent(): ReviewFindingEvent {
  return {
    version: 1,
    type: 'finding',
    finding: {
      category: 'correctness',
      classification: 'defect',
      severity: 'high',
      confidence: 0.9,
      fileId: '000001',
      path: 'src/example.ts',
      side: 'RIGHT',
      line: 1,
      evidence: 'new',
      impact: 'Returns the wrong value.',
      fix: 'Restore the required value.',
    },
  } as unknown as ReviewFindingEvent;
}

function completionEvent(outcome: 'clean' | 'findings'): ReviewCompletionEvent {
  return {
    version: 1,
    type: 'completion',
    outcome,
    coverage: { reviewedFileIds: ['000001'], omitted: [], capabilityFailures: [] },
  } as unknown as ReviewCompletionEvent;
}

function byteStream(chunks: readonly string[]): AsyncIterable<Uint8Array> {
  return (async function* stream() {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })();
}

class FakeRunningBackend implements RunningReviewBackend {
  readonly reporting: BackendReporting = { backend: 'pi' };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = byteStream([]);
  readonly #exit: Promise<BackendExit>;

  constructor(stdout: readonly string[]) {
    this.stdout = byteStream(stdout);
    this.#exit = Promise.resolve({ code: 0, signal: null });
  }

  wait(): Promise<BackendExit> {
    return this.#exit;
  }

  async stop(): Promise<void> {}

  async kill(): Promise<void> {}
}

class FakeLauncher implements ReviewBackendLauncher {
  starts = 0;
  prompt = '';
  readonly #running: FakeRunningBackend;

  constructor(running: FakeRunningBackend) {
    this.#running = running;
  }

  async start(input: { prompt: string }): Promise<RunningReviewBackend> {
    this.starts += 1;
    this.prompt = input.prompt;
    return this.#running;
  }
}

class FakePublisher implements ReviewForgePublisher {
  head = HEAD;
  summaries: string[] = [];
  inline: InlinePublication[] = [];

  async currentHead(): Promise<string> {
    return this.head;
  }

  async upsertSummary(_scope: unknown, body: string): Promise<number> {
    this.summaries.push(body);
    return this.summaries.length;
  }

  async publishInline(_scope: unknown, publication: InlinePublication): Promise<number> {
    this.inline.push(publication);
    return 100 + this.inline.length;
  }
}

async function withBundle<T>(run: (fixture: { root: string; review: string; source: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'redline-action-'));
  const review = join(root, 'review');
  const source = join(root, 'source');
  await mkdir(join(review, 'diffs'), { recursive: true });
  await mkdir(join(review, 'base-files'), { recursive: true });
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(review, 'revisions.txt'), `base=${BASE}\nhead=${HEAD}\n`);
  await writeFile(
    join(review, 'manifest.json'),
    JSON.stringify({
      version: 1,
      base: BASE,
      head: HEAD,
      files: [
        {
          id: '000001',
          status: 'M',
          oldPath: null,
          newPath: 'src/example.ts',
          similarity: null,
          additions: 1,
          deletions: 1,
          binary: false,
          diffFile: 'diffs/000001.diff',
          baseFile: 'base-files/000001',
        },
      ],
    }),
  );
  await writeFile(
    join(review, 'diffs/000001.diff'),
    'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
  );
  await writeFile(join(review, 'base-files/000001'), 'old\n');
  await writeFile(join(source, 'src/example.ts'), 'new\n');
  try {
    return await run({ root, review, source });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('executeAction runs the review with controlled publisher and launcher', async () => {
  await withBundle(async (fixture) => {
    const running = new FakeRunningBackend([
      `${piDelta([JSON.stringify(findingEvent()), JSON.stringify(completionEvent('findings'))].join('\n'))}\n`,
    ]);
    const launcher = new FakeLauncher(running);
    const publisher = new FakePublisher();
    const environment = validEnvironment({
      reviewDirectory: fixture.review,
      sourceDirectory: fixture.source,
      journalPath: join(fixture.root, 'journal.jsonl'),
      reportStyle: 'inline',
    });
    const parsed = parseActionEnvironment(environment);
    if (parsed.mode !== 'review') throw new Error('expected review mode');
    const result = await executeAction(
      {
        parsed: parsed.parsed,
        reviewDirectory: parsed.reviewDirectory,
        sourceDirectory: parsed.sourceDirectory,
        journalPath: parsed.journalPath,
        identity: parsed.identity,
        githubToken: 'token-sentinel',
      },
      { publisher, launcher },
    );
    assert.deepEqual(result, { status: 'complete', outcome: 'findings' });
    assert.equal(launcher.starts, 1);
    assert.match(publisher.summaries.at(-1) as string, /Review completed with findings/u);
    assert.equal(publisher.inline.length, 1);
    assert.match(launcher.prompt, /"findingScope": "defects"/u);
    assert.match(launcher.prompt, /"reportStyle": "inline"/u);
    assert.doesNotMatch(launcher.prompt, /selected-secret/u);
    const journal = await readFile(parsed.journalPath, 'utf8');
    assert.match(journal, /"type":"run"/u);
    assert.doesNotMatch(journal, /selected-secret/u);
  });
});

test('the built CLI validates inputs and exits 2 with unknown environment variables', async () => {
  const bad = processEnvironment(validEnvironment());
  (bad as Record<string, string>).REDLINE_REVIEW_INSTRUCTIONS = 'untrusted-value';
  await assert.rejects(
    () => executeFile('node', ['dist/src/github-action-run-cli.js', '--validate-only'], { env: bad }),
    /unknown environment variable/u,
  );
});

test('the built CLI reports context-only mode with exit code 0', async () => {
  const { stdout } = await executeFile('node', ['dist/src/github-action-run-cli.js', '--validate-only'], {
    env: processEnvironment(contextOnlyEnvironment()),
  });
  assert.deepEqual(JSON.parse(stdout), { mode: 'context-only' });
});

test('the built CLI reports review mode with the parsed timeout', async () => {
  const { stdout } = await executeFile('node', ['dist/src/github-action-run-cli.js', '--validate-only'], {
    env: processEnvironment(validEnvironment({ timeout: '1h' })),
  });
  assert.deepEqual(JSON.parse(stdout), { mode: 'review', backend: 'pi', timeoutMinutes: 60 });
});
