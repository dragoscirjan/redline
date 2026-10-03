import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  collectBoundedDiagnostic,
  consumeBoundedLines,
  type BackendExit,
  type BackendReporting,
  type ReviewBackendLauncher,
  type RunningReviewBackend,
} from '../src/backend-process.js';
import { parseReviewRunArguments } from '../src/review-run-cli.js';
import { runReview, type ReviewRunInput } from '../src/review-run.js';
import type { InlinePublication, ReviewForgePublisher } from '../src/review-publication.js';
import type { ReviewCompletionEvent, ReviewFindingEvent } from '../src/review-report.js';
import { OPENCODE_TEXT_DELTA_PREFIX, OPENCODE_TEXT_END_PREFIX } from '../src/review-stream.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const executeFile = promisify(execFile);

async function withBundle<T>(run: (fixture: { root: string; review: string; source: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'redline-run-'));
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
  };
}

function completionEvent(outcome: 'clean' | 'findings' | 'incomplete'): ReviewCompletionEvent {
  return {
    version: 1,
    type: 'completion',
    outcome,
    coverage: outcome === 'incomplete'
      ? {
          reviewedFileIds: [],
          omitted: [{ fileId: '000001', reason: 'Inspection did not complete.' }],
          capabilityFailures: [],
        }
      : { reviewedFileIds: ['000001'], omitted: [], capabilityFailures: [] },
  };
}

function piDelta(text: string): string {
  return JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
}

function byteStream(chunks: readonly string[], waitFor?: Promise<void>): AsyncIterable<Uint8Array> {
  return (async function* stream() {
    for (const chunk of chunks) yield Buffer.from(chunk);
    if (waitFor) await waitFor;
  })();
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

class FakeRunningBackend implements RunningReviewBackend {
  readonly reporting: BackendReporting;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  stopCalls = 0;
  killCalls = 0;
  readonly #exit: Promise<BackendExit>;
  readonly #resolveExit: ((value: BackendExit) => void) | undefined;
  readonly #resolveStreams: (() => void) | undefined;
  readonly #stopExits: boolean;
  readonly #killExits: boolean;
  readonly #stopFailure: Error | undefined;

  constructor(input: {
    stdout: string[];
    stderr?: string[];
    exit?: BackendExit;
    hang?: boolean;
    stopExits?: boolean;
    killExits?: boolean;
    stopFailure?: Error;
    reporting?: BackendReporting;
  }) {
    this.reporting = input.reporting ?? { backend: 'pi' };
    this.#stopExits = input.stopExits ?? true;
    this.#killExits = input.killExits ?? true;
    this.#stopFailure = input.stopFailure;
    if (input.hang) {
      const exit = deferred<BackendExit>();
      const streams = deferred<void>();
      this.#exit = exit.promise;
      this.#resolveExit = exit.resolve;
      this.#resolveStreams = () => streams.resolve();
      this.stdout = byteStream(input.stdout, streams.promise);
      this.stderr = byteStream(input.stderr ?? [], streams.promise);
    } else {
      this.#exit = Promise.resolve(input.exit ?? { code: 0, signal: null });
      this.stdout = byteStream(input.stdout);
      this.stderr = byteStream(input.stderr ?? []);
    }
  }

  wait(): Promise<BackendExit> {
    return this.#exit;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.#stopFailure) throw this.#stopFailure;
    if (this.#stopExits) this.#finish({ code: 143, signal: 'SIGTERM' });
  }

  async kill(): Promise<void> {
    this.killCalls += 1;
    if (this.#killExits) this.#finish({ code: 137, signal: 'SIGKILL' });
  }

  #finish(exit: BackendExit): void {
    this.#resolveExit?.(exit);
    this.#resolveStreams?.();
  }
}

class FakeLauncher implements ReviewBackendLauncher {
  starts = 0;
  prompt = '';
  constructor(readonly running: FakeRunningBackend, readonly failure?: Error) {}

  async start(input: { prompt: string }): Promise<RunningReviewBackend> {
    this.starts += 1;
    this.prompt = input.prompt;
    if (this.failure) throw this.failure;
    return this.running;
  }
}

class FakePublisher implements ReviewForgePublisher {
  head = HEAD;
  summaries: string[] = [];
  inline: InlinePublication[] = [];
  inlineFailure: Error | undefined;

  async currentHead(): Promise<string> {
    return this.head;
  }

  async upsertSummary(_scope: unknown, body: string): Promise<number> {
    this.summaries.push(body);
    return this.summaries.length;
  }

  async publishInline(_scope: unknown, publication: InlinePublication): Promise<number> {
    if (this.inlineFailure) throw this.inlineFailure;
    this.inline.push(publication);
    return 100 + this.inline.length;
  }
}

function runInput(
  fixture: { root: string; review: string; source: string },
  publisher: FakePublisher,
  launcher: FakeLauncher,
  overrides: Partial<ReviewRunInput> = {},
): ReviewRunInput {
  return {
    backend: 'pi',
    reviewDirectory: fixture.review,
    sourceDirectory: fixture.source,
    journalPath: join(fixture.root, 'journal.jsonl'),
    findingScope: 'defects',
    identity: {
      runId: 'run-18',
      repository: 'owner/repository',
      pullRequest: 18,
      base: BASE,
      head: HEAD,
      reportStyle: 'single-block',
    },
    timeoutMs: 1_000,
    terminationGraceMs: 10,
    publisher,
    launcher,
    ...overrides,
  };
}

function completeOutput(outcome: 'clean' | 'findings' | 'incomplete', finding = false): string[] {
  const events = [
    ...(finding ? [JSON.stringify(findingEvent())] : []),
    JSON.stringify(completionEvent(outcome)),
  ].join('\n') + '\n';
  return [`${piDelta(events)}\n`];
}

test('completes clean and finding reviews without treating findings as failures', async () => {
  for (const scenario of [
    { outcome: 'clean' as const, finding: false },
    { outcome: 'findings' as const, finding: true },
  ]) {
    await withBundle(async (fixture) => {
      const publisher = new FakePublisher();
      const running = new FakeRunningBackend({ stdout: completeOutput(scenario.outcome, scenario.finding) });
      const launcher = new FakeLauncher(running);
      const result = await runReview(runInput(fixture, publisher, launcher));
      assert.deepEqual(result, { status: 'complete', outcome: scenario.outcome });
      assert.equal(launcher.starts, 1);
      assert.match(launcher.prompt, /redline-review\/v2/u);
      assert.match(launcher.prompt, /"findingScope": "defects"/u);
      assert.match(launcher.prompt, /"subagents": false/u);
      assert.match(launcher.prompt, /"vulnerabilityLookupTool": null/u);
      assert.match(launcher.prompt, /"reviewDirectory":"\/workspace\/review"/u);
      assert.match(launcher.prompt, /"sourceDirectory":"\/workspace\/source"/u);
      assert.doesNotMatch(launcher.prompt, new RegExp(fixture.root.replaceAll('\\', '\\\\'), 'u'));
      assert.match(publisher.summaries.at(-1) as string, /Review completed/u);
      const journal = await readFile(join(fixture.root, 'journal.jsonl'), 'utf8');
      if (scenario.finding) assert.match(journal, /finding-accepted/u);
    });
  }
});

test('accepts only the configured OpenCode coordinator session', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const coordinator = { version: 1, sessionID: 'coordinator', messageID: 'm-1', partID: 'p-1' };
    const running = new FakeRunningBackend({
      reporting: { backend: 'opencode', sessionId: 'coordinator' },
      stdout: [
        `${OPENCODE_TEXT_DELTA_PREFIX}${JSON.stringify({ ...coordinator, sessionID: 'subagent', delta: '{bad}' })}\n`,
        `${OPENCODE_TEXT_DELTA_PREFIX}${JSON.stringify({ ...coordinator, delta: JSON.stringify(completionEvent('clean')) })}\n`,
        `${OPENCODE_TEXT_END_PREFIX}${JSON.stringify(coordinator)}\n`,
      ],
    });
    const launcher = new FakeLauncher(running);
    const result = await runReview(runInput(fixture, publisher, launcher, { backend: 'opencode' }));
    assert.deepEqual(result, { status: 'complete', outcome: 'clean' });
  });
});

test('stops a running container when its reporting backend does not match', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const running = new FakeRunningBackend({
      reporting: { backend: 'opencode', sessionId: 'coordinator' },
      stdout: [],
      hang: true,
    });
    const launcher = new FakeLauncher(running);
    assert.deepEqual(
      await runReview(runInput(fixture, publisher, launcher)),
      { status: 'incomplete', reason: 'backend-failure' },
    );
    assert.equal(running.stopCalls, 1);
  });
});

test('preserves a finding and finalizes incomplete when the backend times out', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const running = new FakeRunningBackend({
      stdout: [`${piDelta(`${JSON.stringify(findingEvent())}\n`)}\n`],
      hang: true,
    });
    const launcher = new FakeLauncher(running);
    const result = await runReview(runInput(fixture, publisher, launcher, { timeoutMs: 20 }));
    assert.deepEqual(result, { status: 'incomplete', reason: 'backend-timeout' });
    assert.equal(running.stopCalls, 1);
    assert.match(await readFile(join(fixture.root, 'journal.jsonl'), 'utf8'), /finding-accepted/u);
    assert.match(publisher.summaries.at(-1) as string, /backend reached its time limit/u);
  });
});

test('returns after timeout when graceful and forced termination do not release the streams', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const running = new FakeRunningBackend({
      stdout: [],
      hang: true,
      stopFailure: new Error('stop failed'),
      killExits: false,
    });
    const launcher = new FakeLauncher(running);
    assert.deepEqual(
      await runReview(runInput(fixture, publisher, launcher, { timeoutMs: 20 })),
      { status: 'incomplete', reason: 'backend-timeout' },
    );
    assert.equal(running.stopCalls, 1);
    assert.equal(running.killCalls, 1);
  });
});

test('classifies non-zero exit, missing completion, and launch failure as backend failures', async () => {
  await withBundle(async (fixture) => {
    const scenarios = [
      new FakeLauncher(new FakeRunningBackend({
        stdout: completeOutput('clean'),
        exit: { code: 2, signal: null },
      })),
      new FakeLauncher(new FakeRunningBackend({ stdout: [] })),
      new FakeLauncher(new FakeRunningBackend({ stdout: completeOutput('findings') })),
      new FakeLauncher(new FakeRunningBackend({ stdout: [] }), new Error('launch failed')),
    ];
    for (const [index, launcher] of scenarios.entries()) {
      const publisher = new FakePublisher();
      const input = runInput(fixture, publisher, launcher, {
        journalPath: join(fixture.root, `journal-${index}.jsonl`),
      });
      assert.deepEqual(await runReview(input), { status: 'incomplete', reason: 'backend-failure' });
    }
  });
});

test('journals structured backend diagnostics with exit detail and summary detail on backend-failure', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const launcher = new FakeLauncher(new FakeRunningBackend({
      stdout: ['not a harness line\n'],
      stderr: ['fatal: model endpoint rejected\n'],
      exit: { code: 3, signal: null },
    }));
    const journalPath = join(fixture.root, 'journal.jsonl');
    const result = await runReview(runInput(fixture, publisher, launcher, { journalPath }));
    assert.deepEqual(result, { status: 'incomplete', reason: 'backend-failure' });
    const journal = await readFile(journalPath, 'utf8');
    const diagnostic = journal
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'backend-diagnostic');
    assert.ok(diagnostic, 'journal must contain a backend-diagnostic event');
    assert.match(diagnostic.stderr, /model endpoint rejected/u);
    // The publication message carries the structured detail too.
    const summary = publisher.summaries.at(-1) as string;
    assert.match(summary, /exit code 3/u);
    assert.match(summary, /first protocol error/u);
  });
});

test('drops narration, rejects schema violations, and persists valid siblings', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const text = [
      'I will now inspect the manifest.',
      JSON.stringify(findingEvent()),
      JSON.stringify(completionEvent('findings')),
    ].join('\n') + '\n';
    const launcher = new FakeLauncher(new FakeRunningBackend({ stdout: [`${piDelta(text)}\n`] }));
    const result = await runReview(runInput(fixture, publisher, launcher));
    assert.deepEqual(result, { status: 'complete', outcome: 'findings' });
    const journal = await readFile(join(fixture.root, 'journal.jsonl'), 'utf8');
    assert.match(journal, /finding-accepted/u);
    assert.match(journal, /backend-diagnostic/u);
    // The dropped narration line's content is captured in the diagnostic.
    assert.match(journal, /I will now inspect the manifest/u);
  });
});

test('drops unknown event types as chatter and completes the run', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const progress = JSON.stringify({
      version: 1,
      type: 'progress',
      message: 'Reading revisions.txt and manifest.json to confirm review scope.',
    });
    const text = [
      progress,
      JSON.stringify(findingEvent()),
      JSON.stringify(completionEvent('findings')),
    ].join('\n') + '\n';
    const launcher = new FakeLauncher(new FakeRunningBackend({ stdout: [`${piDelta(text)}\n`] }));
    const journalPath = join(fixture.root, 'journal.jsonl');
    const result = await runReview(runInput(fixture, publisher, launcher, { journalPath }));
    assert.deepEqual(result, { status: 'complete', outcome: 'findings' });
    const journal = await readFile(journalPath, 'utf8');
    assert.match(journal, /backend-diagnostic/u);
    assert.match(journal, /finding-accepted/u);
  });
});

test('a missing completion event still fails the run', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const progress = JSON.stringify({ version: 1, type: 'progress', message: 'working' });
    const typo = JSON.stringify({ version: 1, type: 'compleiton', outcome: 'findings' });
    const text = [progress, JSON.stringify(findingEvent()), typo].join('\n') + '\n';
    const launcher = new FakeLauncher(new FakeRunningBackend({ stdout: [`${piDelta(text)}\n`] }));
    const result = await runReview(runInput(fixture, publisher, launcher));
    assert.deepEqual(result, { status: 'incomplete', reason: 'backend-failure' });
  });
});

test('drops findings that fail diff-mapping validation and completes the run', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const mismatched = {
      ...findingEvent(),
      finding: { ...findingEvent().finding, evidence: 'totally different text' },
    };
    const text = [
      JSON.stringify(mismatched),
      JSON.stringify(findingEvent()),
      JSON.stringify(completionEvent('findings')),
    ].join('\n') + '\n';
    const launcher = new FakeLauncher(new FakeRunningBackend({ stdout: [`${piDelta(text)}\n`] }));
    const journalPath = join(fixture.root, 'journal.jsonl');
    const result = await runReview(runInput(fixture, publisher, launcher, { journalPath }));
    assert.deepEqual(result, { status: 'complete', outcome: 'findings' });
    const journal = await readFile(journalPath, 'utf8');
    assert.match(journal, /finding-rejected/u);
    assert.match(journal, /does not match the authoritative diff line/u);
    assert.match(journal, /finding-accepted/u);
    // single-block style: findings publish via the summary, not inline.
    assert.equal(publisher.inline.length, 0);
  });
});

test('fails the run when a line is valid JSON but violates the event schema', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    const text = [
      JSON.stringify({ ...findingEvent(), bogus: true }),
      JSON.stringify(completionEvent('findings')),
    ].join('\n') + '\n';
    const launcher = new FakeLauncher(new FakeRunningBackend({ stdout: [`${piDelta(text)}\n`] }));
    const result = await runReview(runInput(fixture, publisher, launcher));
    assert.deepEqual(result, { status: 'incomplete', reason: 'backend-failure' });
  });
});

test('maps model coverage and inline publication failures to host-owned incomplete reasons', async () => {
  await withBundle(async (fixture) => {
    const coveragePublisher = new FakePublisher();
    const coverageLauncher = new FakeLauncher(
      new FakeRunningBackend({ stdout: completeOutput('incomplete') }),
    );
    assert.deepEqual(
      await runReview(runInput(fixture, coveragePublisher, coverageLauncher)),
      { status: 'incomplete', reason: 'coverage-incomplete' },
    );

    const publicationPublisher = new FakePublisher();
    publicationPublisher.inlineFailure = new Error('GitHub unavailable');
    const publicationLauncher = new FakeLauncher(
      new FakeRunningBackend({ stdout: completeOutput('findings', true) }),
    );
    const publicationInput = runInput(fixture, publicationPublisher, publicationLauncher, {
      journalPath: join(fixture.root, 'publication-journal.jsonl'),
      identity: {
        runId: 'run-18-inline',
        repository: 'owner/repository',
        pullRequest: 18,
        base: BASE,
        head: HEAD,
        reportStyle: 'inline',
      },
    });
    assert.deepEqual(
      await runReview(publicationInput),
      { status: 'incomplete', reason: 'publication-failure' },
    );
  });
});

test('does not launch the backend when running-summary initialization fails', async () => {
  await withBundle(async (fixture) => {
    const publisher = new FakePublisher();
    publisher.head = 'c'.repeat(40);
    const launcher = new FakeLauncher(new FakeRunningBackend({ stdout: completeOutput('clean') }));
    await assert.rejects(runReview(runInput(fixture, publisher, launcher)), /head changed/u);
    assert.equal(launcher.starts, 0);
  });
});

test('frames split UTF-8, CRLF, and final lines while enforcing byte limits', async () => {
  const encoded = Buffer.from('α\r\nβ');
  const splitLines: string[] = [];
  const chunks = (async function* stream() {
    yield encoded.subarray(0, 1);
    yield encoded.subarray(1, 4);
    yield encoded.subarray(4);
  })();
  await consumeBoundedLines(chunks, async (line) => {
    splitLines.push(line);
  });
  assert.deepEqual(splitLines, ['α', 'β']);

  await assert.rejects(
    consumeBoundedLines(byteStream(['12345']), async () => undefined, { lineBytes: 4, totalBytes: 10 }),
    /line exceeds/u,
  );
  await assert.rejects(
    consumeBoundedLines(byteStream(['1234', '56']), async () => undefined, { lineBytes: 5, totalBytes: 5 }),
    /stdout exceeds/u,
  );
});

test('bounds retained stderr while draining all chunks', async () => {
  const diagnostic = await collectBoundedDiagnostic(byteStream(['abcd', 'efgh']), 5);
  assert.equal(diagnostic.text, 'abcde');
  assert.equal(diagnostic.truncated, true);
});

test('runs the CLI entry point when Node receives an installed-style symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-cli-link-'));
  try {
    const link = join(root, 'redline-review-run');
    await symlink(join(process.cwd(), 'dist/src/review-run-cli.js'), link);
    const result = await executeFile(process.execPath, [link, '--help']);
    assert.match(result.stdout, /^Usage: redline-review-run/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI accepts only fixed prepared-container options', () => {
  const baseArguments = [
    '--backend', 'pi',
    '--review-dir', '/review',
    '--source-dir', '/source',
    '--journal', '/tmp/journal',
    '--repository', 'owner/repository',
    '--pull-request', '18',
    '--base', BASE,
    '--head', HEAD,
    '--run-id', 'run-18',
    '--container-engine', 'podman',
    '--container-id', 'redline-review-18',
  ];
  const parsed = parseReviewRunArguments(baseArguments);
  assert.notEqual(parsed, 'help');
  assert.throws(() => parseReviewRunArguments([...baseArguments, '--command', 'sh']), /unsupported option/u);
  assert.throws(
    () => parseReviewRunArguments(baseArguments.map((value) => value === 'pi' ? 'opencode' : value)),
    /session-id is required/u,
  );
});
