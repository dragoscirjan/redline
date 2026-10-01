import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadReviewBundle } from '../src/review-bundle.js';
import { ReviewJournal, type ReviewRunScope } from '../src/review-journal.js';
import {
  ReviewFindingValidator,
  parseReviewEvent,
  type ReviewCompletionEvent,
  type ReviewFindingEvent,
} from '../src/review-report.js';
import {
  ReviewPublicationService,
  type InlinePublication,
  type ReviewForgePublisher,
} from '../src/review-publication.js';
import {
  OPENCODE_TEXT_DELTA_PREFIX,
  OPENCODE_TEXT_END_PREFIX,
  ReviewBackendOutputConsumer,
  ReviewEventStreamParser,
  extractOpenCodeTextDelta,
  extractPiTextDelta,
} from '../src/review-stream.js';

const executeFile = promisify(execFile);
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

async function withBundle<T>(run: (fixture: { root: string; review: string; source: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'redline-report-'));
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

function findingEvent(overrides: Partial<ReviewFindingEvent['finding']> = {}): ReviewFindingEvent {
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
      ...overrides,
    },
  };
}

function completionEvent(outcome: 'clean' | 'findings' | 'incomplete' = 'findings'): ReviewCompletionEvent {
  return {
    version: 1,
    type: 'completion',
    outcome,
    coverage: {
      reviewedFileIds: ['000001'],
      omitted: [],
      capabilityFailures: [],
    },
  };
}

const SCOPE: ReviewRunScope = {
  runId: 'run-1',
  repository: 'owner/repository',
  pullRequest: 14,
  base: BASE,
  head: HEAD,
  policyId: 'redline-review/v2',
  policyDigest: `sha256:${'c'.repeat(64)}`,
  reportStyle: 'inline',
};

class FakePublisher implements ReviewForgePublisher {
  head = HEAD;
  summaries: string[] = [];
  inline: InlinePublication[] = [];
  inlineFailure: Error | undefined;
  afterInline: (() => Promise<void>) | undefined;

  async currentHead(): Promise<string> {
    return this.head;
  }

  async upsertSummary(_scope: ReviewRunScope, body: string): Promise<number> {
    this.summaries.push(body);
    return 41;
  }

  async publishInline(_scope: ReviewRunScope, publication: InlinePublication): Promise<number> {
    if (this.inlineFailure) throw this.inlineFailure;
    this.inline.push(publication);
    if (this.afterInline) await this.afterInline();
    return 100 + this.inline.length;
  }
}

test('parses chunked review events and backend text deltas', () => {
  const parser = new ReviewEventStreamParser();
  const finding = `${JSON.stringify(findingEvent())}\n`;
  const completion = JSON.stringify(completionEvent());
  assert.deepEqual(parser.push(finding.slice(0, 20)), []);
  assert.equal(parser.push(`${finding.slice(20)}${completion.slice(0, 10)}`).length, 1);
  assert.equal(parser.push(completion.slice(10)).length, 0);
  const result = parser.finish()[0];
  assert.ok(result?.ok);
  assert.equal(result.event.type, 'completion');
  assert.equal(parser.completed, true);

  assert.equal(
    extractPiTextDelta(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })),
    'x',
  );
  assert.equal(
    extractOpenCodeTextDelta(
      `REDLINE_REVIEW_TEXT_DELTA ${JSON.stringify({ version: 1, sessionID: 's', delta: 'y' })}`,
    ),
    'y',
  );
});

test('feeds complete Pi events to host code without model tools', async () => {
  const accepted: Array<'finding' | 'completion'> = [];
  const consumer = new ReviewBackendOutputConsumer({
    backend: 'pi',
    sink: {
      accept(event) {
        accepted.push(event.type);
        return Promise.resolve();
      },
    },
  });
  const text = `${JSON.stringify(findingEvent())}\n${JSON.stringify(completionEvent())}\n`;
  for (const delta of [text.slice(0, 30), text.slice(30)]) {
    await consumer.pushHarnessLine(
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }),
    );
  }
  await consumer.finish();
  assert.deepEqual(accepted, ['finding', 'completion']);
  assert.equal(consumer.completed, true);
});

test('OpenCode output plugin forwards text deltas without adding a model tool', async () => {
  const pluginUrl = pathToFileURL(
    join(process.cwd(), 'packages/opencode-runner/opencode/redline-report-plugin.js'),
  ).href;
  const script = `
    const { RedlineReportPlugin } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await RedlineReportPlugin();
    await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
      sessionID: 'session-1', messageID: 'message-1', id: 'part-1', type: 'text', text: ''
    } } } });
    await hooks.event({ event: { type: 'message.part.delta', properties: {
      sessionID: 'session-1', messageID: 'message-1', partID: 'part-1', field: 'text', delta: 'chunk'
    } } });
    await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
      sessionID: 'session-1', messageID: 'message-1', id: 'part-2', type: 'reasoning', text: ''
    } } } });
    await hooks.event({ event: { type: 'message.part.delta', properties: {
      sessionID: 'session-1', messageID: 'message-1', partID: 'part-2', field: 'text', delta: 'ignored-reasoning'
    } } });
    await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
      sessionID: 'session-2', messageID: 'message-2', id: 'part-3', type: 'text', text: ''
    } } } });
    await hooks.event({ event: { type: 'message.part.delta', properties: {
      sessionID: 'session-2', messageID: 'message-2', partID: 'part-3', field: 'text', delta: 'ignored-session'
    } } });
    await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
      sessionID: 'session-1', messageID: 'message-1', id: 'part-1', type: 'text', text: 'chunk',
      time: { start: 1, end: 2 }
    } } } });
  `;
  const result = await executeFile(process.execPath, ['--input-type=module', '--eval', script], {
    env: {
      ...process.env,
      REDLINE_REPORT_EVENTS: '1',
      REDLINE_COORDINATOR_SESSION_ID: 'coordinator',
    },
  });
  assert.match(result.stdout, /^REDLINE_REVIEW_TEXT_DELTA /u);
  assert.doesNotMatch(result.stdout, /ignored-reasoning|ignored-session/u);
  const outputLines = result.stdout.trim().split('\n');
  assert.equal(outputLines.length, 2);
  assert.equal(extractOpenCodeTextDelta(outputLines[0] as string, 'coordinator'), 'chunk');
  assert.match(outputLines[1] as string, /^REDLINE_REVIEW_TEXT_END /u);
});

test('OpenCode consumer accepts only the selected plugin session and ignores native aggregate text', async () => {
  const accepted: Array<'finding' | 'completion'> = [];
  const consumer = new ReviewBackendOutputConsumer({
    backend: 'opencode',
    sessionId: 'coordinator',
    sink: {
      accept(event) {
        accepted.push(event.type);
        return Promise.resolve();
      },
    },
  });
  const text = `${JSON.stringify(findingEvent())}\n${JSON.stringify(completionEvent())}\n`;
  await consumer.pushHarnessLine(
    `REDLINE_REVIEW_TEXT_DELTA ${JSON.stringify({ version: 1, sessionID: 'subagent', delta: text })}`,
  );
  await consumer.pushHarnessLine(
    `REDLINE_REVIEW_TEXT_DELTA ${JSON.stringify({ version: 1, sessionID: 'coordinator', delta: text })}`,
  );
  await consumer.pushHarnessLine(JSON.stringify({ type: 'text', part: { text } }));
  await consumer.finish();
  assert.deepEqual(accepted, ['finding', 'completion']);
});

test('flushes Pi message and OpenCode text-part boundaries without trailing newlines', async () => {
  for (const backend of ['pi', 'opencode'] as const) {
    const accepted: Array<'finding' | 'completion'> = [];
    const sink = {
      accept(event: ReviewFindingEvent | ReviewCompletionEvent) {
        accepted.push(event.type);
        return Promise.resolve();
      },
    };
    const consumer = backend === 'pi'
      ? new ReviewBackendOutputConsumer({ backend, sink })
      : new ReviewBackendOutputConsumer({ backend, sink, sessionId: 'coordinator' });
    const segments = [JSON.stringify(findingEvent()), JSON.stringify(completionEvent())];
    for (const [index, segment] of segments.entries()) {
      if (backend === 'pi') {
        await consumer.pushHarnessLine(
          JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: segment } }),
        );
        await consumer.pushHarnessLine(JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }));
      } else {
        const envelope = { version: 1, sessionID: 'coordinator', messageID: `m-${index}`, partID: `p-${index}` };
        await consumer.pushHarnessLine(`${OPENCODE_TEXT_DELTA_PREFIX}${JSON.stringify({ ...envelope, delta: segment })}`);
        await consumer.pushHarnessLine(`${OPENCODE_TEXT_END_PREFIX}${JSON.stringify(envelope)}`);
      }
    }
    assert.deepEqual(accepted, ['finding', 'completion']);
  }
});

test('returns malformed, repeated, and post-completion lines as parse failures', () => {
  const parser = new ReviewEventStreamParser();
  const malformed = parser.push('{bad}\n')[0];
  assert.equal(malformed?.ok, false);
  if (!malformed?.ok) assert.match(malformed?.error.message ?? '', /not valid JSON/u);

  const completed = new ReviewEventStreamParser();
  completed.push(`${JSON.stringify(completionEvent('clean'))}\n`);
  const afterCompletion = completed.push(`${JSON.stringify(findingEvent())}\n`)[0];
  assert.equal(afterCompletion?.ok, false);
  if (!afterCompletion?.ok) assert.match(afterCompletion?.error.message ?? '', /after completion/u);

  assert.throws(
    () => parseReviewEvent({ ...findingEvent(), unexpected: true }),
    /unsupported fields/u,
  );
});

test('delivers valid sibling events when parsing or sink acceptance fails', async () => {
  const accepted: Array<'finding' | 'completion'> = [];
  let findingCalls = 0;
  const consumer = new ReviewBackendOutputConsumer({
    backend: 'pi',
    sink: {
      accept(event) {
        accepted.push(event.type);
        if (event.type === 'finding' && findingCalls++ === 0) return Promise.reject(new Error('rejected finding'));
        return Promise.resolve();
      },
    },
  });
  const text = [
    JSON.stringify(findingEvent()),
    '{bad}',
    JSON.stringify(findingEvent({ impact: 'Second valid finding.' })),
    JSON.stringify(completionEvent()),
  ].join('\n') + '\n';
  await assert.rejects(
    consumer.pushHarnessLine(
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }),
    ),
    AggregateError,
  );
  assert.deepEqual(accepted, ['finding', 'finding', 'completion']);
  assert.equal(consumer.completed, true);
});

test('validates changed lines, exact evidence, finding scope, and completion consistency', async () => {
  await withBundle(async ({ review, source }) => {
    const bundle = await loadReviewBundle(review, source);
    const validator = await ReviewFindingValidator.create(bundle, 'defects');
    const validated = validator.validateFinding(findingEvent().finding);
    assert.match(validated.id, /^f-[0-9a-f]{24}$/u);
    assert.throws(
      () => validator.validateFinding(findingEvent({ line: 2 }).finding),
      /not a changed line/u,
    );
    assert.throws(
      () => validator.validateFinding(findingEvent({ evidence: 'different' }).finding),
      /does not match/u,
    );
    assert.equal(
      validator.validateFinding(findingEvent({ side: 'LEFT', evidence: 'old' }).finding).path,
      'src/example.ts',
    );
    assert.throws(
      () => validator.validateFinding(findingEvent({ classification: 'risk' }).finding),
      /configured finding scope/u,
    );
    assert.equal(validator.validateCompletion(completionEvent(), 1).outcome, 'findings');
    assert.throws(() => validator.validateCompletion(completionEvent('clean'), 1), /inconsistent/u);
  });
});

test('serializes concurrent journal deduplication and finding limits', async () => {
  await withBundle(async ({ root, review, source }) => {
    const bundle = await loadReviewBundle(review, source);
    const validator = await ReviewFindingValidator.create(bundle, 'defects');
    const journal = await ReviewJournal.create(join(root, 'journal.jsonl'), SCOPE);
    const duplicateFinding = validator.validateFinding(findingEvent().finding);
    const duplicates = await Promise.all([
      journal.recordFinding(duplicateFinding),
      journal.recordFinding(duplicateFinding),
    ]);
    assert.deepEqual(duplicates.map((item) => item.duplicate), [false, true]);

    const unique = Array.from({ length: 10 }, (_, index) =>
      validator.validateFinding(findingEvent({ impact: `Impact ${index}` }).finding),
    );
    const results = await Promise.allSettled(unique.map((finding) => journal.recordFinding(finding)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 9);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(journal.snapshot().findings.length, 10);
    await journal.close();
  });
});

test('persists before progressive inline publication and finalizes from journal state', async () => {
  await withBundle(async ({ root, review, source }) => {
    const bundle = await loadReviewBundle(review, source);
    const validator = await ReviewFindingValidator.create(bundle, 'defects');
    const journalPath = join(root, 'journal.jsonl');
    const journal = await ReviewJournal.create(journalPath, SCOPE);
    const publisher = new FakePublisher();
    const service = new ReviewPublicationService({
      validator,
      journal,
      publisher,
      scope: SCOPE,
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    await service.initialize();
    const receipt = await service.accept(findingEvent());
    assert.equal('id' in receipt, true);
    assert.equal(publisher.inline.length, 1);
    const journalText = await readFile(journalPath, 'utf8');
    assert.match(journalText, /finding-accepted/u);
    assert.match(journalText, /finding-published/u);

    const duplicate = await service.accept(findingEvent());
    assert.equal('duplicate' in duplicate && duplicate.duplicate, true);
    assert.equal(publisher.inline.length, 1);

    await service.accept(completionEvent());
    await service.finalize({ status: 'complete' });
    assert.equal(publisher.summaries.length, 2);
    assert.match(publisher.summaries[1] as string, /Review completed with findings/u);
    assert.match(publisher.summaries[1] as string, /does not repeat them/u);
    await journal.close();
  });
});

test('propagates journal failure after a successful inline publication', async () => {
  await withBundle(async ({ root, review, source }) => {
    const bundle = await loadReviewBundle(review, source);
    const validator = await ReviewFindingValidator.create(bundle, 'defects');
    const journal = await ReviewJournal.create(join(root, 'journal.jsonl'), SCOPE);
    const publisher = new FakePublisher();
    publisher.afterInline = async () => journal.close();
    const service = new ReviewPublicationService({ validator, journal, publisher, scope: SCOPE });

    await service.initialize();
    await assert.rejects(service.accept(findingEvent()), /journal is closed/u);
    assert.equal(publisher.inline.length, 1);
    assert.equal(journal.snapshot().publicationFailures.size, 0);
  });
});

test('keeps failed inline findings in the journal and exposes the failure', async () => {
  await withBundle(async ({ root, review, source }) => {
    const bundle = await loadReviewBundle(review, source);
    const validator = await ReviewFindingValidator.create(bundle, 'defects');
    const journal = await ReviewJournal.create(join(root, 'journal.jsonl'), SCOPE);
    const publisher = new FakePublisher();
    publisher.inlineFailure = new Error('GitHub unavailable');
    const service = new ReviewPublicationService({ validator, journal, publisher, scope: SCOPE });

    await service.initialize();
    await service.accept(findingEvent());
    await service.accept(completionEvent());
    assert.equal(journal.snapshot().publicationFailures.size, 1);
    await assert.rejects(service.finalize({ status: 'complete' }), /cannot hide publication failures/u);
    await service.finalize({
      status: 'incomplete',
      reason: 'publication-failure',
      message: 'One or more inline findings could not be published.',
    });
    assert.match(publisher.summaries.at(-1) as string, /could not be published/u);
    await journal.close();
  });
});

test('renders persisted partial findings with a trusted timeout message', async () => {
  await withBundle(async ({ root, review, source }) => {
    const scope = { ...SCOPE, reportStyle: 'single-block' as const };
    const bundle = await loadReviewBundle(review, source);
    const validator = await ReviewFindingValidator.create(bundle, 'defects');
    const journal = await ReviewJournal.create(join(root, 'journal.jsonl'), scope);
    const publisher = new FakePublisher();
    const service = new ReviewPublicationService({ validator, journal, publisher, scope });

    await service.initialize();
    await service.accept(findingEvent());
    assert.equal(publisher.inline.length, 0);
    await service.finalize({
      status: 'incomplete',
      reason: 'backend-timeout',
      message: 'The model reached its time limit. Coverage may be incomplete.',
    });
    const summary = publisher.summaries.at(-1) as string;
    assert.match(summary, /Review incomplete/u);
    assert.match(summary, /model reached its time limit/u);
    assert.match(summary, /Returns the wrong value/u);
    await journal.close();
  });
});
