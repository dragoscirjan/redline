import {
  collectBoundedDiagnostic,
  consumeBoundedLines,
  type BackendExit,
  type ReviewBackend,
  type ReviewBackendLauncher,
  type RunningReviewBackend,
} from './backend-process.js';
import { loadReviewBundle } from './review-bundle.js';
import { ReviewJournal, type ReviewRunScope } from './review-journal.js';
import { ReviewPublicationService, type ReviewForgePublisher } from './review-publication.js';
import { ReviewFindingValidator } from './review-report.js';
import {
  MODEL_VISIBLE_REVIEW_DIRECTORY,
  MODEL_VISIBLE_SOURCE_DIRECTORY,
  REVIEW_PROMPT_ID,
  assembleReviewPrompt,
  type FindingScope,
  type ReportStyle,
} from './review-prompt.js';
import { ReviewBackendOutputConsumer, type ReviewEventSink } from './review-stream.js';
import { boundedDiagnosticText, type BackendDiagnosticEvent } from './review-diagnostics.js';

// Matches the 360-minute GitHub Actions job cap so a `timeout` action input
// accepted by validation is also honurable by the run deadline.
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_PROTOCOL_ERRORS = 32;

export interface ReviewRunIdentity {
  runId: string;
  repository: string;
  pullRequest: number;
  base: string;
  head: string;
  reportStyle: ReportStyle;
}

export interface ReviewRunInput {
  backend: ReviewBackend;
  reviewDirectory: string;
  sourceDirectory: string;
  journalPath: string;
  findingScope: FindingScope;
  identity: ReviewRunIdentity;
  timeoutMs: number;
  publisher: ReviewForgePublisher;
  launcher: ReviewBackendLauncher;
  terminationGraceMs?: number;
}

export type ReviewRunResult =
  | { status: 'complete'; outcome: 'clean' | 'findings' }
  | {
      status: 'incomplete';
      reason: 'backend-timeout' | 'backend-failure' | 'coverage-incomplete' | 'publication-failure';
    };

type TerminalEvent =
  | { kind: 'timeout' }
  | { kind: 'exit'; exit: BackendExit }
  | { kind: 'execution-failure'; error: unknown };

function positiveBoundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function validateIdentity(identity: ReviewRunIdentity): void {
  if (identity.runId.length === 0 || identity.runId.length > 128) throw new Error('run id is invalid');
  if (!/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.test(identity.repository)) {
    throw new Error('repository must use owner/name syntax');
  }
  if (!Number.isSafeInteger(identity.pullRequest) || identity.pullRequest <= 0) {
    throw new Error('pull request number must be positive');
  }
  const revisionPattern = /^([0-9a-f]{40}|[0-9a-f]{64})$/u;
  if (!revisionPattern.test(identity.base) || !revisionPattern.test(identity.head)) {
    throw new Error('review revisions must be lowercase full object ids');
  }
  if (identity.reportStyle !== 'single-block' && identity.reportStyle !== 'inline') {
    throw new Error('report style is unsupported');
  }
}

function createDeadline(milliseconds: number): { promise: Promise<{ kind: 'timeout' }>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), milliseconds);
  });
  return {
    promise,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(milliseconds).then(() => false),
  ]);
}

async function succeedsWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => false,
    ),
    delay(milliseconds).then(() => false),
  ]);
}

async function terminateBackend(
  running: RunningReviewBackend,
  waitPromise: Promise<BackendExit>,
  graceMs: number,
): Promise<void> {
  const stopPromise = running.stop();
  void stopPromise.catch(() => undefined);
  if (!(await succeedsWithin(stopPromise, graceMs))) {
    const killPromise = running.kill();
    void killPromise.catch(() => undefined);
    await settleWithin(killPromise, graceMs);
  }
  await settleWithin(waitPromise, graceMs);
}

function fixedMessage(reason: Extract<ReviewRunResult, { status: 'incomplete' }>['reason']): string {
  switch (reason) {
    case 'backend-timeout':
      return 'The review backend reached its time limit.';
    case 'coverage-incomplete':
      return 'The review backend reported incomplete coverage.';
    case 'publication-failure':
      return 'One or more inline findings could not be published.';
    default:
      return 'The review backend failed before complete coverage was confirmed.';
  }
}

async function finalizeIncomplete(
  publication: ReviewPublicationService,
  reason: Extract<ReviewRunResult, { status: 'incomplete' }>['reason'],
  journal?: ReviewJournal,
  recordDiagnostic?: (journal: ReviewJournal) => Promise<void>,
  detail?: string,
): Promise<ReviewRunResult> {
  if (detail !== undefined && detail.length > 0) {
    process.stderr.write(`review incomplete (${reason}): ${detail}\n`);
  }
  if (journal && recordDiagnostic) {
    try {
      await recordDiagnostic(journal);
    } catch {
      // Journal diagnostics are best-effort; the incomplete outcome matters more.
    }
  }
  // The publication message is capped at 500 characters by the schema; keep
  // the full detail on stderr and in the journal, and truncate here.
  const message =
    detail !== undefined && detail.length > 0
      ? `${fixedMessage(reason)} Detail: ${[...detail].slice(0, 200).join('')}...`
      : fixedMessage(reason);
  await publication.finalize({ status: 'incomplete', reason, message });
  return { status: 'incomplete', reason };
}

function assertReportingBackend(running: RunningReviewBackend, backend: ReviewBackend): void {
  if (running.reporting.backend !== backend) throw new Error('running backend reporting mode does not match the review backend');
}

export async function runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  validateIdentity(input.identity);
  const timeoutMs = positiveBoundedInteger(input.timeoutMs, MAX_TIMEOUT_MS, 'review timeout');
  const terminationGraceMs = positiveBoundedInteger(
    input.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    30_000,
    'termination grace period',
  );
  if (input.backend !== 'pi' && input.backend !== 'opencode') throw new Error('review backend is unsupported');
  if (input.findingScope !== 'defects' && input.findingScope !== 'defects-and-risks') {
    throw new Error('finding scope is unsupported');
  }

  const [bundle, prompt] = await Promise.all([
    loadReviewBundle(input.reviewDirectory, input.sourceDirectory),
    assembleReviewPrompt({
      reviewDirectory: input.reviewDirectory,
      sourceDirectory: input.sourceDirectory,
      modelVisibleReviewDirectory: MODEL_VISIBLE_REVIEW_DIRECTORY,
      modelVisibleSourceDirectory: MODEL_VISIBLE_SOURCE_DIRECTORY,
      inspection: 'read-only',
      findingScope: input.findingScope,
      vulnerabilityChecks: 'off',
      vulnerabilityTool: 'unavailable',
      reporting: 'events',
      reportStyle: input.identity.reportStyle,
      subagents: 'unavailable',
    }),
  ]);
  if (prompt.base !== input.identity.base || prompt.head !== input.identity.head) {
    throw new Error('review bundle revisions do not match the run identity');
  }

  const scope: ReviewRunScope = {
    ...input.identity,
    policyId: REVIEW_PROMPT_ID,
    policyDigest: prompt.policyDigest,
  };
  const validator = await ReviewFindingValidator.create(bundle, input.findingScope);
  const journal = await ReviewJournal.create(input.journalPath, scope);
  let primaryFailure = false;

  try {
    const publication = new ReviewPublicationService({
      validator,
      journal,
      publisher: input.publisher,
      scope,
    });
    await publication.initialize();

    const deadline = createDeadline(timeoutMs);
    const launchAbort = new AbortController();
    const launchPromise = input.launcher.start({
      backend: input.backend,
      prompt: prompt.prompt,
      signal: launchAbort.signal,
    });
    const launchOutcome = await Promise.race([
      launchPromise.then(
        (running) => ({ kind: 'running' as const, running }),
        (error: unknown) => ({ kind: 'launch-failure' as const, error }),
      ),
      deadline.promise,
    ]);

    if (launchOutcome.kind === 'timeout') {
      launchAbort.abort();
      void launchPromise
        .then(async (running) => terminateBackend(running, running.wait(), terminationGraceMs))
        .catch(() => undefined);
      deadline.cancel();
      return await finalizeIncomplete(publication, 'backend-timeout');
    }
    if (launchOutcome.kind === 'launch-failure') {
      deadline.cancel();
      return await finalizeIncomplete(publication, 'backend-failure');
    }

    const running = launchOutcome.running;
    const waitPromise = running.wait();
    void waitPromise.catch(() => undefined);
    let acceptingEvents = true;
    const sink: ReviewEventSink = {
      accept(event) {
        if (!acceptingEvents) return Promise.reject(new Error('review run no longer accepts backend events'));
        return publication.accept(event);
      },
    };
    let consumer: ReviewBackendOutputConsumer;
    try {
      assertReportingBackend(running, input.backend);
      consumer = running.reporting.backend === 'pi'
        ? new ReviewBackendOutputConsumer({ backend: 'pi', sink })
        : new ReviewBackendOutputConsumer({
            backend: 'opencode',
            sessionId: running.reporting.sessionId,
            sink,
          });
    } catch {
      launchAbort.abort();
      await terminateBackend(running, waitPromise, terminationGraceMs);
      deadline.cancel();
      return await finalizeIncomplete(publication, 'backend-failure');
    }
    let protocolErrorCount = 0;
    let acceptedEventCount = 0;
    const firstProtocolError: { message?: string } = {};
    const firstRejectedLine: { text?: string } = {};
    const consumeLine = async (line: string): Promise<void> => {
      try {
        await consumer.pushHarnessLine(line);
        acceptedEventCount += 1;
      } catch (error) {
        if (firstProtocolError.message === undefined) {
          if (error instanceof AggregateError && error.errors.length > 0) {
            const inner = error.errors[0];
            firstProtocolError.message = inner instanceof Error ? inner.message : String(inner);
          } else {
            firstProtocolError.message = error instanceof Error ? error.message : String(error);
          }
        }
        if (firstRejectedLine.text === undefined) {
          firstRejectedLine.text = boundedDiagnosticText(line, 'rejected harness line').slice(0, 8192);
        }
        protocolErrorCount = Math.min(protocolErrorCount + 1, MAX_PROTOCOL_ERRORS);
      }
    };

    const stdoutPromise = (async () => {
      await consumeBoundedLines(running.stdout, consumeLine);
      try {
        await consumer.finish();
      } catch (error) {
        if (firstProtocolError.message === undefined) {
          firstProtocolError.message = error instanceof Error ? error.message : String(error);
        }
        protocolErrorCount = Math.min(protocolErrorCount + 1, MAX_PROTOCOL_ERRORS);
      }
    })();
    const stderrPromise = collectBoundedDiagnostic(running.stderr);
    void stdoutPromise.catch(() => undefined);
    void stderrPromise.catch(() => undefined);
    const recordDiagnostic = (journal: ReviewJournal): Promise<void> =>
      Promise.all([stderrPromise, stdoutPromise])
        .then(([diagnostic]) => {
          const event: BackendDiagnosticEvent = {
            stderr: boundedDiagnosticText(diagnostic.text, 'backend stderr'),
            ...(firstProtocolError.message !== undefined
              ? { firstProtocolError: firstProtocolError.message }
              : {}),
            ...(firstRejectedLine.text !== undefined
              ? { firstRejectedEvent: firstRejectedLine.text }
              : {}),
            rejectedEvents: protocolErrorCount,
            acceptedEvents: acceptedEventCount,
          };
          return journal.recordDiagnostic(event);
        })
        .catch(() => undefined);

    const executionPromise = Promise.all([stdoutPromise, stderrPromise, waitPromise]).then(
      ([, , exit]): TerminalEvent => ({ kind: 'exit', exit }),
      (error: unknown): TerminalEvent => ({ kind: 'execution-failure', error }),
    );
    const terminal = await Promise.race<TerminalEvent>([deadline.promise, executionPromise]);

    if (terminal.kind !== 'exit') {
      acceptingEvents = false;
      launchAbort.abort();
      await terminateBackend(running, waitPromise, terminationGraceMs);
    }
    deadline.cancel();

    const allSettled = Promise.allSettled([stdoutPromise, stderrPromise, waitPromise]);
    const settled = terminal.kind === 'exit'
      ? await allSettled
      : await Promise.race([
          allSettled,
          delay(terminationGraceMs).then(() => undefined),
        ]);
    if (terminal.kind === 'timeout') return await finalizeIncomplete(publication, 'backend-timeout');

    const stdoutFailed = !settled || settled[0].status === 'rejected';
    const stderrFailed = !settled || settled[1].status === 'rejected';
    const waitFailed = !settled || settled[2].status === 'rejected';
    const exit = terminal.kind === 'exit' ? terminal.exit : undefined;
    const snapshot = journal.snapshot();
    if (
      terminal.kind === 'execution-failure' ||
      stdoutFailed ||
      stderrFailed ||
      waitFailed ||
      !exit ||
      exit.code !== 0 ||
      exit.signal !== null ||
      protocolErrorCount > 0 ||
      !snapshot.completion
    ) {
      const details: string[] = [];
      if (exit) {
        if (exit.code !== null) details.push(`exit code ${exit.code}`);
        if (exit.signal !== null) details.push(`signal ${exit.signal}`);
      }
      if (terminal.kind === 'execution-failure') {
        details.push(
          `controller error: ${terminal.error instanceof Error ? terminal.error.message : String(terminal.error)}`,
        );
      }
      if (firstProtocolError.message !== undefined) {
        details.push(`first protocol error: ${firstProtocolError.message}`);
      }
      if (protocolErrorCount > 0) {
        details.push(`protocol errors: ${protocolErrorCount}, accepted events: ${acceptedEventCount}`);
        if (firstRejectedLine.text !== undefined) {
          details.push(`first rejected line: ${firstRejectedLine.text.slice(0, 400)}`);
        }
      }
      return await finalizeIncomplete(
        publication,
        'backend-failure',
        journal,
        recordDiagnostic,
        details.join('; ') || undefined,
      );
    }
    if (snapshot.completion.outcome === 'incomplete') {
      return await finalizeIncomplete(publication, 'coverage-incomplete');
    }
    if (snapshot.publicationFailures.size > 0) {
      return await finalizeIncomplete(publication, 'publication-failure');
    }

    await publication.finalize({ status: 'complete' });
    return { status: 'complete', outcome: snapshot.completion.outcome };
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    try {
      await journal.close();
    } catch (error) {
      if (!primaryFailure) throw error;
    }
  }
}
