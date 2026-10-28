import type { ReviewEvent, ReviewReporter, ReviewReport } from '../application/review.ts';
import type { PullRequestFinding } from '../review/types.ts';
import { MAX_EXCERPT_LINES, type FindingDiffExcerpt } from './finding-diff.ts';

/** Terminal data is untrusted too: remove control characters and bound every line. */
export function terminalText(value: string, credential?: string): string {
  const redacted = credential === undefined || credential.length === 0 ? value : value.split(credential).join('[redacted]');
  return redacted.replaceAll('\t', '    ').replace(/[\p{Cc}\p{Cf}]/gu, '?').slice(0, 512);
}

export function terminalColors(mode: 'auto' | 'always' | 'never', tty: boolean, env: NodeJS.ProcessEnv): boolean {
  return mode !== 'never' && env.NO_COLOR === undefined && env.TERM !== 'dumb' && (mode === 'always' || tty);
}

export interface CliReporterOptions {
  readonly color?: boolean;
  readonly terminal?: {
    readonly write: (text: string) => void;
    readonly columns: () => number;
    readonly color: boolean;
  };
  readonly readDiff?: (finding: PullRequestFinding, revisions: { readonly base: string; readonly head: string }) => Promise<FindingDiffExcerpt | undefined>;
}

type Status = 'waiting' | 'running' | 'clean' | 'findings' | 'inert' | 'omitted';
type Tone = 'green' | 'red' | 'gray' | 'yellow' | 'blue';
const COLORS: Readonly<Record<Tone, number>> = { green: 32, red: 31, gray: 90, yellow: 33, blue: 36 };
const SYMBOLS: Readonly<Record<Status, { readonly plain: string; readonly colored: string; readonly tone: Tone }>> = {
  waiting: { plain: '.', colored: '○', tone: 'gray' },
  running: { plain: 'o', colored: '○', tone: 'blue' },
  clean: { plain: '+', colored: '●', tone: 'green' },
  findings: { plain: 'x', colored: '●', tone: 'red' },
  inert: { plain: '-', colored: '●', tone: 'gray' },
  omitted: { plain: '!', colored: '!', tone: 'yellow' },
};

export class CliReporter implements ReviewReporter {
  readonly id = 'cli';
  private readonly stdout: (line: string) => void;
  private readonly stderr: (line: string) => void;
  private readonly credential: string | undefined;
  private readonly options: CliReporterOptions;
  private readonly files = new Map<string, Status>();
  private activeLine = false;
  private reported = false;
  constructor(stdout: (line: string) => void, stderr: (line: string) => void, credential?: string, options: CliReporterOptions = {}) {
    this.stdout = stdout; this.stderr = stderr; this.credential = credential; this.options = options;
  }
  private tint(text: string, tone: Tone, enabled = this.options.color === true): string {
    return enabled ? `\u001b[${COLORS[tone]}m${text}\u001b[0m` : text;
  }
  private strip(color: boolean, maximum: number): string {
    const states = [...this.files.values()];
    const visible = states.slice(0, Math.max(0, maximum - (states.length > maximum ? 1 : 0)));
    return visible.map((state) => {
      const symbol = SYMBOLS[state];
      return this.tint(color ? symbol.colored : symbol.plain, symbol.tone, color);
    }).join('') + (visible.length < states.length && maximum > 0 ? '…' : '');
  }
  private redraw(): void {
    const terminal = this.options.terminal;
    if (terminal === undefined || this.reported || this.files.size === 0) return;
    const states = [...this.files.values()];
    const done = states.filter((state) => !['waiting', 'running'].includes(state)).length;
    const running = states.filter((state) => state === 'running').length;
    const width = Math.max(1, Math.min(240, Math.floor(terminal.columns() || 80)) - 1);
    const prefix = `Review ${done}/${states.length} · ${running} running `;
    const available = Math.max(0, width - prefix.length - 2);
    const frame = prefix.slice(0, width) + (available > 0 ? `[${this.strip(terminal.color, available)}]` : '');
    // One physical line, no cursor movement into previous output and no terminal-width wrapping.
    terminal.write(`\r\u001b[2K${frame}`);
    this.activeLine = true;
  }
  private finishLine(): void {
    if (this.activeLine) this.options.terminal?.write('\n');
    this.activeLine = false;
  }
  private clearLine(): void {
    if (this.activeLine) this.options.terminal?.write('\r\u001b[2K');
    this.activeLine = false;
  }
  async preflight(): Promise<void> {}
  progress(event: ReviewEvent): void {
    if (event.kind === 'cleanup-failed') {
      this.finishLine();
      this.stderr('Warning: temporary snapshot cleanup failed; the review outcome is unchanged.');
      return;
    }
    if (this.reported) return;
    if (event.kind === 'started') {
      this.stderr(this.options.terminal === undefined ? 'Reviewing changes…' : 'Capturing changes…');
    } else if (event.kind === 'context-started') {
      this.clearLine();
      this.stderr(`Preparing ${terminalText(event.provider)} context…`);
    } else if (event.kind === 'context-ready') {
      this.clearLine();
      if (event.indexCache !== undefined) this.stderr(`Base index: ${event.indexCache}`);
      if (event.fileOnlyFiles > 0) {
        this.stderr(`Indexed context: ${terminalText(event.status)}; ${event.relatedSpans} related spans; ${event.fileOnlyFiles} required ${event.fileOnlyFiles === 1 ? 'file remains' : 'files remain'} file-only.`);
      }
    } else if (event.kind === 'workload') {
      // Erase the transient bar before permanent preflight messages. A newline
      // here would leave a second progress bar behind in terminal history.
      this.clearLine();
      this.stderr(`Workload: ${event.files} uncached files; ${event.workers} workers; ${event.scheduling}; ${Math.floor(event.remainingMs / 1000)}s remaining.`);
      if (event.staticHeadFiles > 0) this.stderr(`Static head context: ${event.staticHeadFiles} files; bounded import candidates, not verified call paths.`);
      if (event.mayExceedDeadline) this.stderr(`Deadline warning: all files exhausting their configured attempt allowances would need up to ${Math.ceil(event.maximumExecutionMs / 1000)}s of model execution. This is a worst-case bound, not a latency forecast; limits are unchanged.`);
    } else if (event.kind === 'planned') {
      this.files.clear();
      for (const file of event.files.slice(0, 2_000)) this.files.set(file.fileId, file.reviewed ? 'waiting' : 'inert');
    } else if (event.kind === 'file-started' || event.kind === 'file-retry') {
      if (this.files.has(event.fileId) && this.files.get(event.fileId) !== 'inert') this.files.set(event.fileId, 'running');
    } else if (event.kind === 'file-completed') {
      if (this.files.has(event.fileId)) this.files.set(event.fileId, event.outcome);
    } else if (event.kind === 'failed') {
      this.finishLine();
      this.stderr('Review interrupted or failed; coverage is incomplete.');
      this.reported = true;
      return;
    } else {
      this.finishLine();
      return;
    }
    this.redraw();
  }
  private section(title: string): void {
    this.stdout('');
    this.stdout(this.tint(title, 'blue'));
  }
  private row(label: string, value: string): void {
    this.stdout(`  ${label.padEnd(17)} ${terminalText(value, this.credential)}`);
  }
  private paragraph(value: string, indent = '  '): void {
    const width = Math.max(20, Math.min(96, this.options.terminal?.columns() ?? 88) - indent.length);
    let remaining = Array.from(terminalText(value, this.credential));
    while (remaining.length > width) {
      const space = remaining.lastIndexOf(' ', width);
      const end = space > 0 ? space : width;
      this.stdout(indent + remaining.slice(0, end).join(''));
      remaining = Array.from(remaining.slice(end).join('').trimStart());
    }
    if (remaining.length > 0) this.stdout(indent + remaining.join(''));
  }
  private duration(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  private harnessMessage(diagnostic: string): string {
    try {
      const value: unknown = JSON.parse(diagnostic);
      if (value === null || typeof value !== 'object' || !('schema' in value)) return diagnostic;
      if (value.schema === 'pi-error/v1' && 'message' in value && typeof value.message === 'string') {
        return ('status' in value && typeof value.status === 'number' ? `HTTP ${value.status}: ` : '') + value.message;
      }
      if (value.schema === 'pi-no-text/v1' && 'class' in value) {
        switch (value.class) {
          case 'model-output-budget-exhausted': {
            const tokens = 'outputTokens' in value && typeof value.outputTokens === 'number' && Number.isSafeInteger(value.outputTokens)
              && value.outputTokens >= 0 ? ` after ${value.outputTokens} output tokens` : '';
            return `Output limit reached${tokens}; no usable final answer. See artifacts for transport details.`;
          }
          case 'capture-truncated': return 'Harness output exceeded the capture limit; no usable final answer.';
          case 'malformed-events': return 'Harness returned malformed stream events; no usable final answer.';
          case 'missing-turn-end': return 'Harness stream ended without a final turn.';
          case 'missing-text-parts': return 'Harness final turn contained no answer text.';
          case 'empty-text': return 'Harness final answer was empty.';
        }
      }
    } catch { /* Unknown diagnostics retain the same bounded, redacted fallback. */ }
    return diagnostic;
  }
  private block(value: string, maximum = 20): void {
    const lines = value.split('\n');
    for (const line of lines.slice(0, maximum)) {
      const safe = terminalText(line, this.credential);
      this.stdout(`    ${line.startsWith('+') ? this.tint(safe, 'green') : line.startsWith('-') ? this.tint(safe, 'red') : safe}`);
    }
    if (lines.length > maximum) this.stdout('    … truncated; full text is in the artifacts.');
  }
  private async finding(finding: PullRequestFinding, result: ReviewReport): Promise<void> {
    const safe = (text: string): string => terminalText(text, this.credential);
    const confidence = Number.isFinite(finding.confidence) ? Math.round(finding.confidence * 100) + '%' : 'unknown';
    this.stdout(`  ${this.tint(finding.severity.toUpperCase(), finding.severity === 'low' ? 'yellow' : 'red')} ${safe(finding.classification)}, ${finding.startLine}-${finding.endLine} [${finding.side}], ${confidence} model confidence`);
    this.paragraph(finding.title);
    this.stdout('');
    this.stdout('  Impact');
    this.paragraph(finding.impact, '    ');
    if (finding.uncertainty.length > 0) {
      this.stdout('  Uncertainty');
      this.paragraph(finding.uncertainty, '    ');
    }
    this.stdout('');
    this.stdout('  Reviewed change (> marks the cited lines):');
    let excerpt: FindingDiffExcerpt | undefined;
    try { excerpt = await this.options.readDiff?.(finding, result.review); } catch { /* optional presentation */ }
    if (excerpt === undefined) this.stdout('    Excerpt unavailable; see the authoritative review artifacts.');
    else {
      this.stdout(`    ${safe(excerpt.header)}`);
      for (const line of excerpt.lines.slice(0, MAX_EXCERPT_LINES)) {
        const numbers = `${line.left === null ? '     ' : String(line.left).padStart(5)} ${line.right === null ? '     ' : String(line.right).padStart(5)}`;
        const text = safe(line.text);
        const rendered = line.text.startsWith('+') ? this.tint(text, 'green') : line.text.startsWith('-') ? this.tint(text, 'red') : text;
        this.stdout(`  ${line.cited ? '>' : ' '} ${numbers} ${rendered}`);
      }
      if (excerpt.truncated || excerpt.lines.length > MAX_EXCERPT_LINES) this.stdout('    … excerpt clipped; the full diff is in the artifacts.');
    }
    if (finding.suggestion === undefined) this.stdout('  Proposed fix: none supplied.');
    else { this.stdout('  Proposed fix (not applied or test-verified):'); this.block(finding.suggestion); }
    this.stdout('');
  }
  async complete(result: ReviewReport): Promise<void> {
    this.finishLine();
    this.reported = true;
    const safe = (value: string): string => terminalText(value, this.credential);
    const incomplete = result.summary.omittedFiles > 0 || ['incomplete', 'unavailable'].includes(result.review.coverage.files.status);
    const heading = incomplete ? 'Review incomplete' : result.summary.reviewedFiles === 0 ? 'No reviewable files' : 'Review finished';
    this.stdout(this.tint(heading, incomplete ? 'yellow' : result.review.findings.length > 0 ? 'red' : result.summary.reviewedFiles === 0 ? 'gray' : 'green'));
    this.stdout('');
    const completed = result.summary.reviewedFiles - result.summary.omittedFiles;
    this.row('Coverage:', `${completed}/${result.summary.reviewedFiles} required files completed; ${result.summary.omittedFiles} failed; ${result.summary.excludedFiles?.length ?? 0} inert`);
    this.row('Findings:', String(result.review.findings.length));
    this.row('Verdict:', result.review.verdict.status);

    this.section('Execution');
    const reuse = result.summary.reuse;
    if (reuse !== undefined) this.row('Reuse:', reuse.status === 'enabled'
      ? `${reuse.reusedFiles} validated file${reuse.reusedFiles === 1 ? '' : 's'} reused; ${reuse.executedFiles} executed.` : reuse.status);
    const retries = result.summary.retries;
    if (retries !== undefined) {
      this.row('Retries:', `${retries.attempts} review attempts; ${retries.retriedFiles} file${retries.retriedFiles === 1 ? '' : 's'} retried; ${retries.recoveredFiles} recovered`);
      this.row('Retry limit:', `${retries.limit} additional attempts per file`);
      if (retries.exhaustedFiles > 0) this.row('Retry exhausted:', `${retries.exhaustedFiles} file${retries.exhaustedFiles === 1 ? '' : 's'} used all allowed attempts`);
      if (retries.deadlineSkippedFiles > 0) this.row('Retry deadline:', `${retries.deadlineSkippedFiles} file${retries.deadlineSkippedFiles === 1 ? '' : 's'} could not use their remaining attempts.`);
    }
    if (result.summary.executionBudget !== undefined) {
      const budget = result.summary.executionBudget;
      this.row('Review time:', `${this.duration(budget.elapsedMs)}; ${budget.deadlineExhausted ? 'deadline exhausted' : 'within budget'}`);
    }
    const notStarted = result.summary.files.filter(file => file.execution === 'not-started').length;
    if (notStarted > 0) this.row('Not started:', `${notStarted} file${notStarted === 1 ? '' : 's'} after shared harness failure.`);

    this.section('Context');
    const context = result.summary.codeContext;
    const staticHead = context.diagnosticCodes.includes('static-head-context');
    this.row(staticHead ? 'Related context:' : 'Indexed context:', context.status);
    this.row('Related source:', `${context.filesWithContext} file${context.filesWithContext === 1 ? '' : 's'} with context; ${context.relatedSpans} related span${context.relatedSpans === 1 ? '' : 's'}`);
    if (context.provider !== null) this.row(staticHead ? 'Base provider:' : 'Provider:', `${context.provider.id} ${context.provider.version}`);
    if (staticHead) this.row('Static head:', 'v1 lexical candidates; per-file provenance recorded');
    if (context.diagnosticCodes.length > 0) this.row('Diagnostics:', context.diagnosticCodes.join(', '));

    if (result.omissions.length > 0 || result.summary.harnessFailure !== undefined) this.section('Incomplete reviews');
    if (result.omissions.length > 0) {
      const failures = new Map<string, number>();
      for (const file of result.omissions) failures.set(file.errorKind, (failures.get(file.errorKind) ?? 0) + 1);
      this.stderr(`Failed reviews: ${safe([...failures].slice(0, 8).map(([kind, count]) => `${count} ${kind}`).join('; '))}. File details are in the artifacts.`);
    }
    const harnessFailure = result.summary.harnessFailure;
    if (harnessFailure !== undefined) {
      this.stderr(`Harness error${harnessFailure.scope === 'run' ? ' (stopped queued work)' : ''}: ${safe(this.harnessMessage(harnessFailure.diagnostic))}`);
    }
    const groups = new Map<string, PullRequestFinding[]>();
    for (const finding of result.review.findings.slice(0, 100)) {
      const group = groups.get(finding.triggerPath) ?? []; group.push(finding); groups.set(finding.triggerPath, group);
    }
    if (groups.size > 0) this.section('Findings');
    for (const [path, findings] of groups) {
      this.stdout(''); this.stdout(this.tint(safe(path), 'blue'));
      for (const finding of findings) await this.finding(finding, result);
    }
    if (result.review.findings.length > 100) this.stdout('More findings are available in the artifacts; terminal output is capped at 100.');
    if (result.captureCoverage !== undefined) {
      const coverage = result.captureCoverage;
      this.section('Capture');
      this.row('Untracked:', `${coverage.excludedUntrackedFiles} excluded`);
      this.row('Omitted source:', `${coverage.omittedSourceFiles} oversized file${coverage.omittedSourceFiles === 1 ? '' : 's'}`);
      this.row('Inert entries:', `${coverage.inertSymlinks} symlink${coverage.inertSymlinks === 1 ? '' : 's'}; ${coverage.inertSubmodules} submodule${coverage.inertSubmodules === 1 ? '' : 's'}`);
    }
    this.stdout('');
    this.stdout(`Artifacts: ${safe(result.outputDirectory)}`);
  }

}
