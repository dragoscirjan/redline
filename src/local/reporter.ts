import type { ReviewEvent, ReviewReporter, ReviewReport } from '../application/review.ts';

/** Terminal data is untrusted too: remove control characters and bound every line. */
export function terminalText(value: string, credential?: string): string {
  const redacted = credential === undefined || credential.length === 0 ? value : value.split(credential).join('[redacted]');
  return redacted.replace(/[\p{Cc}\p{Cf}]/gu, '?').slice(0, 512);
}

export class CliReporter implements ReviewReporter {
  readonly id = 'cli';
  private readonly stdout: (line: string) => void;
  private readonly stderr: (line: string) => void;
  private readonly credential: string | undefined;
  constructor(stdout: (line: string) => void, stderr: (line: string) => void, credential?: string) {
    this.stdout = stdout; this.stderr = stderr; this.credential = credential;
  }
  async preflight(): Promise<void> {}
  progress(event: ReviewEvent): void {
    const file = 'fileId' in event ? ` ${event.fileId}` : '';
    const outcome = 'outcome' in event ? ` ${event.outcome}` : '';
    this.stderr(`redline: ${event.kind}${file}${outcome}`);
  }
  async complete(result: ReviewReport): Promise<void> {
    const safe = (value: string): string => terminalText(value, this.credential);
    for (const finding of result.review.findings.slice(0, 100)) {
      this.stdout(`${finding.severity.toUpperCase()} ${safe(finding.triggerPath)}:${finding.startLine}-${finding.endLine} [${finding.side}] ${safe(finding.title)}`);
    }
    this.stdout(`Verdict: ${result.review.verdict.status}; findings: ${result.review.findings.length}`);
    this.stdout(`Coverage: ${result.summary.reviewedFiles} reviewed; ${result.summary.omittedFiles} omitted; ${result.summary.excludedFiles?.length ?? 0} excluded`);
    for (const record of result.omissions.slice(0, 100)) {
      this.stderr(`redline: ${safe(record.path)}: ${record.errorKind ?? 'omitted'}`);
    }
    if (result.captureCoverage !== undefined) {
      const coverage = result.captureCoverage;
      this.stdout(`Capture: ${coverage.excludedUntrackedFiles} untracked excluded; ${coverage.omittedSourceFiles} oversized source omitted; ${coverage.inertSymlinks} inert symlinks; ${coverage.inertSubmodules} inert submodules`);
    }
    this.stdout(`Artifacts: ${safe(result.outputDirectory)}`);
  }
}
