import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFileReviews } from '../src/review/runner.ts';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { WARMUP_TOOLS } from '../src/review/warmup.ts';
import type { HarnessExecutor, HarnessRun } from '../src/harness-executor/types.ts';
import { cleanReviewEnvironment, createBundleFixture, HEAD_SHA } from './helpers/bundle.ts';
import { reviewFinding } from './helpers/finding.ts';

const changed = 'export function format(value: string) {\n  return value.toUpperCase();\n}\n';
const diff = 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,3 @@\n-export function format(value: unknown) {\n-  return String(value);\n+export function format(value: string) {\n+  return value.toUpperCase();\n }\n';
function run(text: unknown, names: string[]): HarnessRun {
  return { harness: 'pi', status: 'succeeded', exitCode: 0, text: JSON.stringify(text), diagnostic: '', durationMs: 1,
    telemetry: { processStartupMs: null, timeToFirstTextMs: null, stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
      tools: { catalogueSource: 'harness-catalogue', catalogue: ['cgc_index', 'cgc_query'], truncated: false,
        calls: names.map(name => ({ name, started: 1, succeeded: 1, failed: 0 })) } } };
}
describe('native code-impact reporting', () => {
  for (const scenario of ['broken-caller', 'compatible-caller', 'forged-caller', 'missing-query', 'missing-impact'] as const) {
    it(scenario + ' preserves source authority and does not equate unchanged callers with defects', async () => {
      const fixture = await createBundleFixture({ diff, headContent: changed, manifestOverrides: { additions: 2, deletions: 2 } });
      try {
        await writeFile(join(fixture.review, 'base-files/000001'), 'export function format(value: unknown) {\n  return String(value);\n}\n');
        const caller = scenario === 'compatible-caller' ? 'export const rendered = format("ok");' : 'export const rendered = format(42);';
        await writeFile(join(fixture.source, 'src/caller.ts'), caller + '\n');
        const citation = { role: 'caller-assumption' as const, revision: HEAD_SHA, path: 'src/caller.ts', startLine: 1, endLine: 1,
          evidence: scenario === 'forged-caller' ? 'invented caller' : caller };
        const environment = { ...parseReviewEnvironment(cleanReviewEnvironment(fixture, 'pi')).review!,
          nativeIndexing: { provider: 'cgc' as const, required: false }, retries: 0 };
        const executor: HarnessExecutor = { harness: 'pi', async prepare(settings) { return { harness: 'pi', model: settings.model, description: 'synthetic native', executionMode: 'native' }; },
          async execute(_prepared, prompt) {
            if (prompt.user.includes('REDLINE_NATIVE_WARMUP')) {
              const target = JSON.parse(prompt.user);
              return run({ kind: target.kind, head: target.head, sourceDirectory: target.sourceDirectory,
                integrations: [...WARMUP_TOOLS.map(component => ({ component, availability: 'unavailable', tools: [], reason: 'optional tool missing' })),
                  { component: 'cgc', availability: 'available', tools: ['cgc_index', 'cgc_query'], indexStatus: 'ready', indexedFiles: 2,
                    persistence: 'shared', probeTool: 'cgc_index', indexTool: 'cgc_index', queryTool: 'cgc_query', reason: 'captured files indexed' }] }, ['cgc_index', 'cgc_query']);
            }
            expect(prompt.system).toContain('including callers outside the diff'); expect(prompt.system).toContain('A caller being unchanged is NOT a defect');
            expect(prompt.system).toContain('cgc_query');
            const findings = scenario === 'broken-caller' ? [reviewFinding({ title: 'Narrowed formatter breaks the existing numeric caller', startLine: 1, endLine: 2,
              evidence: 'export function format(value: string) {', supportingEvidence: [citation],
              impactPath: { status: 'complete', steps: [{ from: 'unchanged numeric caller', to: 'format', relationship: 'passes a number to the string-only implementation', evidence: 'source', referenceIndex: 0 }] },
              behavioralContract: 'Existing numeric inputs were supported.', failureScenario: 'The unchanged caller passes 42; toUpperCase is not a function.' })] : [];
            return run({ version: 4, fileId: '000001', outcome: findings.length > 0 ? 'findings' : 'clean', contextRequests: [], findings,
              ...(scenario === 'missing-impact' ? {} : { impactAnalysis: { status: 'checked', changedSymbols: ['format'], callers: [citation],
                summary: scenario === 'compatible-caller' ? 'The unchanged string caller remains compatible.' : 'The unchanged numeric caller relies on the old coercion contract.', limitation: '' } }) },
            scenario === 'missing-query' ? [] : ['cgc_query']);
          } };
        const result = await runFileReviews({ environment, executor });
        const record = result.records[0]!;
        if (scenario === 'forged-caller' || scenario === 'missing-impact') {
          expect(record.outcome).toBe('omitted'); expect(record.errorKind).toBe('invalid-output');
        } else {
          expect(record.impactAnalysis?.status).toBe(scenario === 'missing-query' ? 'partial' : 'checked');
          expect(record.impactAnalysis?.indexQueryObserved).toBe(scenario !== 'missing-query');
          expect(record.impactAnalysis?.callers[0]?.path).toBe('src/caller.ts');
          expect(record.findings).toHaveLength(scenario === 'broken-caller' ? 1 : 0);
          if (scenario === 'broken-caller') expect(record.findings[0]?.impactPath.status).toBe('complete');
          const markdown = await readFile(join(fixture.output, 'reviews/000001.md'), 'utf8');
          expect(markdown).toContain('## Code impact'); expect(markdown).toContain('src/caller.ts:1-1');
          expect(result.summary.files[0]?.impactAnalysis?.changedSymbols).toEqual(['format']);
        }
      } finally { await fixture.cleanup(); }
    });
  }
});
