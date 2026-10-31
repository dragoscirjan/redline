import { isAbsolute, join } from 'node:path';
import { CompositeReporter, type ReviewEvent, type ReviewReport } from '../application/review.ts';
import { CapabilityError } from '../application/capabilities.ts';
import { redactCredentialText } from '../harness-executor/model-failure.ts';
import { parseLocalOptions, UsageError } from '../local/options.ts';
import { runLocalReview } from '../local/run.ts';
import { CODES, LIMITS, RpcFault, valid, type WireError } from './contract.ts';

export interface Artifacts {
  readonly directory: string; readonly reviewJson: string; readonly reviewMarkdown: string;
  readonly summaryJson: string; readonly statusJson: string;
}
export type RunState = 'running' | 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'timed-out';
export type Section = 'overview' | 'files' | 'findings';
export type Sections = Record<Section, readonly Record<string, unknown>[]>;
export interface Completion {
  readonly state: Exclude<RunState, 'running'>;
  readonly exitCode: number;
  readonly error: WireError | null;
  readonly sections?: Sections;
}
export interface ExecutionCallbacks {
  readonly progress: (event: ReviewEvent) => void;
  readonly artifacts: (value: Artifacts) => void;
}
export type Execute = (selection: Record<string, unknown>, signal: AbortSignal, callbacks: ExecutionCallbacks) => Promise<Completion>;
export function artifacts(directory: string): Artifacts {
  return { directory, reviewJson: join(directory, 'reviews/review.json'), reviewMarkdown: join(directory, 'reviews/review.md'),
    summaryJson: join(directory, 'reviews/summary.json'), statusJson: join(directory, 'status.json') };
}
export function classification(kind: string | undefined): WireError {
  if (kind === 'harness-timeout' || kind === 'run-deadline-exhausted') return { code: CODES.timeout, message: 'Review deadline exhausted' };
  if (kind === 'invalid-output' || kind === 'verification-failed') return { code: CODES.validation, message: 'Review validation incomplete' };
  return { code: CODES.model, message: 'Model execution incomplete' };
}
function projection(report: ReviewReport): Sections | undefined {
  const { review, summary } = report;
  const overview = {
    verdict: review.verdict.status,
    coverage: { status: review.coverage.files.status, requiredFiles: summary.reviewedFiles,
      completedFiles: summary.reviewedFiles - summary.omittedFiles, omittedFiles: summary.omittedFiles,
      excludedFiles: summary.manifestFiles - summary.reviewedFiles, contextStatus: summary.codeContext.status },
    findings: review.findings.length, limitations: review.limitations,
  };
  const sections: Sections = { overview: [overview], files: [], findings: [] };
  let bytes = Buffer.byteLength(JSON.stringify(overview));
  const files: Record<string, unknown>[] = [];
  const findings: Record<string, unknown>[] = [];
  for (const file of summary.files) {
    const item = { fileId: file.fileId, path: file.path, outcome: file.outcome,
      error: file.errorKind === undefined ? null : classification(file.errorKind), diagnostic: file.errorKind === undefined ? null : classification(file.errorKind).message,
      contextStatus: file.codeContext.status, relatedSpans: file.codeContext.relatedSpans };
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > LIMITS.retainedBytes / 2) return undefined;
    if (!valid('file', item)) throw new Error('Invalid file projection');
    files.push(item);
  }
  for (const finding of review.findings) {
    const item = { id: finding.id, fileId: finding.triggerFileId, path: finding.triggerPath,
      title: finding.title, severity: finding.severity, classification: finding.classification, confidence: finding.confidence,
      side: finding.side, startLine: finding.startLine, endLine: finding.endLine, evidence: finding.evidence,
      supportingEvidence: finding.supportingEvidence, rootCause: finding.rootCause, impact: finding.impact, fix: finding.fix,
      suggestion: finding.suggestion ?? null, fixPrompt: finding.fixPrompt,
      verification: { status: finding.verification.status, reason: finding.verification.reason }, remediationStatus: finding.remediationStatus };
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > LIMITS.retainedBytes / 2) return undefined;
    if (!valid('finding', item)) throw new Error('Invalid finding projection');
    findings.push(item);
  }
  if (!valid('overview', overview)) throw new Error('Invalid coverage projection');
  return { ...sections, files, findings };
}
/** Only source selection is accepted over the wire. Settings/credentials come from trusted startup configuration. */
export function localExecutor(startupArgs: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Execute {
  return async (selection, signal, callbacks) => {
    if (typeof selection.repository !== 'string' || !isAbsolute(selection.repository)) throw new RpcFault(CODES.params, 'Repository must be an absolute path');
    const args = [...startupArgs, '--repository', selection.repository, '--base', String(selection.base ?? 'HEAD')];
    if (selection.head !== undefined) args.push('--head', String(selection.head), '--comparison', String(selection.comparison ?? 'merge-base'));
    else args.push('--worktree', String(selection.worktree ?? 'all'), '--untracked', String(selection.untracked ?? 'exclude'));
    let options;
    try { options = await parseLocalOptions(args, env, cwd, signal); }
    catch (error) {
      if (signal.aborted) return { state: 'cancelled', exitCode: 130, error: { code: CODES.cancellation, message: 'Review cancelled' } };
      if (error instanceof CapabilityError) throw new RpcFault(CODES.capability, 'Capability unavailable');
      if (error instanceof UsageError) throw new RpcFault(CODES.configuration, 'Invalid trusted review configuration');
      throw new RpcFault(CODES.revision, 'Repository or revision unavailable');
    }
    const sanitize = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' ? redactCredentialText(item, options.environment.credential?.value) : item)) as T;
    let sections: Sections | undefined;
    const result = await runLocalReview(options, env, { signal, stdout: () => {}, stderr: () => {},
      onOutput: directory => callbacks.artifacts(sanitize(artifacts(directory))),
      reporter: () => new CompositeReporter([{
        id: 'rpc', preflight: async () => {},
        progress: event => callbacks.progress(event),
        complete: async report => {
          const projected = projection(report);
          if (projected === undefined) return;
          const safe = sanitize(projected);
          for (const [section, definition] of [['overview', 'overview'], ['files', 'file'], ['findings', 'finding']] as const) {
            if (!safe[section].every(item => valid(definition, item))) throw new Error('Invalid redacted result projection');
          }
          sections = safe;
        },
      }]),
    });
    const error = result.exitCode === 5 ? { code: CODES.internal, message: 'Protocol reporting failed' }
      : result.status === 'cancelled' ? { code: CODES.cancellation, message: 'Review cancelled' }
      : result.status === 'deadline-exhausted' ? { code: CODES.timeout, message: 'Review deadline exhausted' }
      : result.status === 'failed' ? { code: CODES[result.failureKind ?? 'revision'], message: 'Review preparation failed' }
      : result.status === 'incomplete' ? classification(result.report?.summary.files.find(file => file.errorKind !== undefined)?.errorKind) : null;
    return { state: result.status === 'deadline-exhausted' ? 'timed-out' : result.status, exitCode: result.exitCode, error,
      ...(sections === undefined ? {} : { sections }) };
  };
}
