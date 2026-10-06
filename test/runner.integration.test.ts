import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReviewEnvironment } from '../src/review/environment.js';
import { runFileReviews } from '../src/review/runner.js';
import type { HarnessExecutor, HarnessPrompt, HarnessRun, PreparedHarness } from '../src/harness-executor/types.js';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.js';

/** Scripted executor double: answers prompts from a queue of runs. */
class ScriptedExecutor implements HarnessExecutor {
  readonly harness = 'echo' as const;
  readonly prompts: HarnessPrompt[] = [];
  #runs: HarnessRun[] = [];

  script(runs: Array<Partial<HarnessRun>>): void {
    this.#runs = runs.map((run) => ({
      status: 'succeeded',
      harness: 'echo',
      exitCode: 0,
      text: '',
      diagnostic: '',
      durationMs: 1,
      ...run,
    }));
  }

  async prepare(): Promise<PreparedHarness> {
    return { harness: 'echo', model: { provider: 'mock', endpoint: 'http://x', model: 'test-model' }, description: 'scripted test double' };
  }

  async execute(_prepared: PreparedHarness, prompt: HarnessPrompt): Promise<HarnessRun> {
    this.prompts.push(prompt);
    const next = this.#runs.shift();
    if (next === undefined) throw new Error('scripted executor ran out of scripted runs');
    return next;
  }
}

function reviewDocument(value: object): string {
  return JSON.stringify(value);
}

describe('runFileReviews', () => {
  it('runs one prompt per reviewed file and writes records and summary', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        {
          text: reviewDocument({ version: 2, fileId: '000001', outcome: 'clean', findings: [] }),
        },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });

      expect(result.exitCode).toBe(0);
      expect(executor.prompts).toHaveLength(1);
      // The prompt is self-contained: system policy + untrusted user context.
      expect(executor.prompts[0]!.system).toContain('# Review policy');
      expect(executor.prompts[0]!.user).toContain('"fileId":"000001"');

      const record = JSON.parse(
        await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
      ) as { version: number; outcome: string; rawModelOutput?: string };
      expect(record.version).toBe(2);
      expect(record.outcome).toBe('clean');
      expect(record.rawModelOutput).toBeDefined();
      await expect(readFile(join(fixture.output, 'reviews', '000001.md'), 'utf8')).resolves.toContain(
        '# Review: src/example.ts',
      );

      const summary = JSON.parse(
        await readFile(join(fixture.output, 'reviews', 'summary.json'), 'utf8'),
      ) as { reviewedFiles: number; findings: number; files: Array<{ outcome: string }> };
      expect(summary.reviewedFiles).toBe(1);
      expect(summary.findings).toBe(0);
      expect(summary.files[0]?.outcome).toBe('clean');
    } finally {
      await fixture.cleanup();
    }
  });

  it('validates findings, renders their spans, and derives suggestions and fix prompts', async () => {
    const fixture = await createBundleFixture({
      diff: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new line\n',
      headContent: 'new line\n',
    });
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        {
          text: reviewDocument({
            version: 2,
            fileId: '000001',
            outcome: 'findings',
            findings: [
              {
                category: 'correctness',
                classification: 'defect',
                severity: 'high',
                confidence: 0.9,
                side: 'RIGHT',
                startLine: 1,
                endLine: 1,
                evidence: 'new line',
                impact: 'Wrong result.',
                fix: 'Restore the check.',
                suggestedChange: 'guarded line',
              },
            ],
          }),
        },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(result.exitCode).toBe(0);
      expect(result.summary.findings).toBe(1);
      expect(result.summary.files[0]?.outcome).toBe('findings');
      expect(result.summary.files[0]?.findingSpans).toEqual(['1']);

      const record = JSON.parse(
        await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
      ) as {
        outcome: string;
        findings: Array<{
          id: string;
          startLine: number;
          endLine: number;
          suggestion?: string;
          fixPrompt: string;
          suggestedChange?: unknown;
        }>;
      };
      expect(record.outcome).toBe('findings');
      const finding = record.findings[0]!;
      expect(finding.id).toMatch(/^f-[0-9a-f]{24}$/u);
      expect(finding.startLine).toBe(1);
      expect(finding.endLine).toBe(1);
      expect(finding.suggestion).toBe('-new line\n+guarded line');
      expect(finding.fixPrompt).toContain('Fix one code-review finding.');
      expect(finding.fixPrompt).toContain('Location: src/example.ts:1 (side RIGHT: the new version of the file)');
      expect(finding.fixPrompt).toContain('  1 | new line');
      expect(finding.suggestedChange).toBeUndefined();

      const markdown = await readFile(join(fixture.output, 'reviews', '000001.md'), 'utf8');
      expect(markdown).toContain('— src/example.ts:1');
      expect(markdown).toContain('-new line');
      expect(markdown).toContain('+guarded line');
      const summaryMarkdown = await readFile(join(fixture.output, 'reviews', 'summary.md'), 'utf8');
      expect(summaryMarkdown).toContain('| src/example.ts | findings | 1 (1) |');
    } finally {
      await fixture.cleanup();
    }
  });

  it('records invalid model output as an omitted file and keeps running', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { text: 'definitely not json' },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });
      // Every reviewed file failed validation: the run fails loudly.
      expect(result.exitCode).toBe(1);
      expect(result.summary.omittedFiles).toBe(1);
      expect(result.summary.files[0]?.errorKind).toBe('invalid-output');
    } finally {
      await fixture.cleanup();
    }
  });

  it('records harness failures as omitted files with bounded reasons', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { status: 'failed', diagnostic: 'boom'.repeat(200) },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(result.exitCode).toBe(1);
      const record = JSON.parse(
        await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
      ) as { outcome: string; errorKind?: string; reason?: string };
      expect(record.outcome).toBe('omitted');
      expect(record.errorKind).toBe('harness-failed');
      expect((record.reason ?? '').length).toBeLessThanOrEqual(501);
    } finally {
      await fixture.cleanup();
    }
  });

  it('skips files the bundle marks as not reviewed', async () => {
    const fixture = await createBundleFixture({ reviewed: false });
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(executor.prompts).toHaveLength(0);
      expect(result.summary.reviewedFiles).toBe(0);
      expect(result.exitCode).toBe(0);
      const summaryFiles = await readFile(join(fixture.output, 'reviews', 'summary.json'), 'utf8');
      expect(summaryFiles).toContain('"reviewedFiles": 0');
    } finally {
      await fixture.cleanup();
    }
  });

  it('records binary files as omitted without prompting the harness', async () => {
    const fixture = await createBundleFixture({
      manifestOverrides: { binary: true, baseFile: null },
    });
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      const result = await runFileReviews({ environment: environment.review!, executor });
      expect(executor.prompts).toHaveLength(0);
      expect(result.summary.omittedFiles).toBe(1);
      const record = JSON.parse(
        await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8'),
      ) as { outcome: string; reason?: string };
      expect(record.reason).toMatch(/binary/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('end-to-end with the real echo harness via the registry', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const result = await runFileReviews({ environment: environment.review! });
      expect(result.exitCode).toBe(0);
      expect(result.summary.harness).toBe('echo');
      expect(result.summary.reviewedFiles).toBe(1);
      expect(result.summary.findings).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('records a preparation failure as omitted without aborting the run', async () => {
    const fixture = await createBundleFixture();
    try {
      // A second manifest entry whose diff carries a malformed hunk header;
      // prompt preparation must fail for this file only.
      const manifestPath = join(fixture.review, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        files: Array<Record<string, unknown>>;
      };
      manifest.files.push({
        id: '000002',
        status: 'A',
        oldPath: null,
        newPath: 'src/broken.ts',
        similarity: null,
        additions: 1,
        deletions: 0,
        binary: false,
        diffFile: 'diffs/000002.diff',
        baseFile: null,
      });
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(
        join(fixture.review, 'diffs', '000002.diff'),
        '--- a/src/broken.ts\n+++ b/src/broken.ts\n@@ -1 +1 @@\n@@ malformed hunk header\n',
      );
      await writeFile(join(fixture.source, 'src', 'broken.ts'), 'broken\n');

      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      executor.script([
        { text: reviewDocument({ version: 2, fileId: '000001', outcome: 'clean', findings: [] }) },
        { text: reviewDocument({ version: 2, fileId: '000002', outcome: 'clean', findings: [] }) },
      ]);
      const result = await runFileReviews({ environment: environment.review!, executor });

      // The healthy file is still reviewed; the broken one never reaches the
      // harness.
      expect(result.exitCode).toBe(0);
      expect(executor.prompts).toHaveLength(1);
      expect(result.summary.omittedFiles).toBe(1);

      const broken = JSON.parse(await readFile(join(fixture.output, 'reviews', '000002.json'), 'utf8')) as {
        outcome: string;
        errorKind?: string;
        reason?: string;
      };
      expect(broken.outcome).toBe('omitted');
      expect(broken.errorKind).toBe('preparation-failed');
      expect(broken.reason).toMatch(/malformed hunk header/u);

      const good = JSON.parse(await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8')) as {
        outcome: string;
      };
      expect(good.outcome).toBe('clean');
    } finally {
      await fixture.cleanup();
    }
  });

  it('redacts the selected credential from persisted diagnostics and output', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      // A harness failure whose diagnostic echoes the credential.
      executor.script([
        { status: 'failed', diagnostic: 'connect failed for key test-key at openrouter' },
      ]);
      await runFileReviews({ environment: environment.review!, executor });
      const record = JSON.parse(await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8')) as {
        reason?: string;
      };
      expect(record.reason).toBeDefined();
      expect(record.reason).not.toContain('test-key');
      expect(record.reason).toContain('[redacted]');
    } finally {
      await fixture.cleanup();
    }
  });

  it('redacts the selected credential from persisted raw model output', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      // Output that fails parsing (not JSON) and echoes the credential.
      executor.script([{ text: 'leaked test-key in text' }]);
      await runFileReviews({ environment: environment.review!, executor });
      const record = JSON.parse(await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8')) as {
        rawModelOutput?: string;
      };
      expect(record.rawModelOutput).toBeDefined();
      expect(record.rawModelOutput).not.toContain('test-key');
      expect(record.rawModelOutput).toContain('[redacted]');
    } finally {
      await fixture.cleanup();
    }
  });

  it('redacts the selected credential from derived suggestions and fix prompts', async () => {
    const fixture = await createBundleFixture();
    try {
      const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'echo'));
      const executor = new ScriptedExecutor();
      // A finding whose model-proposed replacement echoes the credential.
      executor.script([
        {
          text: reviewDocument({
            version: 2,
            fileId: '000001',
            outcome: 'findings',
            findings: [
              {
                category: 'correctness',
                classification: 'defect',
                severity: 'high',
                confidence: 0.9,
                side: 'RIGHT',
                startLine: 1,
                endLine: 1,
                evidence: 'new',
                impact: 'Wrong result.',
                fix: 'Restore the check with test-key.',
                suggestedChange: 'guarded using test-key',
              },
            ],
          }),
        },
      ]);
      await runFileReviews({ environment: environment.review!, executor });
      const record = JSON.parse(await readFile(join(fixture.output, 'reviews', '000001.json'), 'utf8')) as {
        findings: Array<{ suggestion?: string; fixPrompt: string }>;
      };
      const finding = record.findings[0]!;
      expect(finding.suggestion).toBeDefined();
      expect(finding.suggestion).not.toContain('test-key');
      expect(finding.suggestion).toContain('[redacted]');
      expect(finding.fixPrompt).not.toContain('test-key');
      expect(finding.fixPrompt).toContain('[redacted]');
    } finally {
      await fixture.cleanup();
    }
  });
});
