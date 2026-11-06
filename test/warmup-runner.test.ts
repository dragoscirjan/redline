import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFileReviews } from '../src/review/runner.ts';
import { parseReviewEnvironment } from '../src/review/environment.ts';
import { WARMUP_COMPONENTS } from '../src/review/warmup.ts';
import type { HarnessExecutor, HarnessPrompt, HarnessRun } from '../src/harness-executor/types.ts';
import { cleanReviewEnvironment, createBundleFixture } from './helpers/bundle.ts';

describe('native warmup review orchestration', () => {
  for (const behavior of ['ready', 'malformed', 'timeout', 'fatal'] as const) {
    it('reports ' + behavior + ' warmup before file work without weakening review validation', async () => {
      const fixture = await createBundleFixture();
      try {
        const environment = parseReviewEnvironment(cleanReviewEnvironment(fixture, 'pi')).review!;
        const events: string[] = [], files: HarnessPrompt[] = [];
        let warmups = 0;
        const executor: HarnessExecutor = { harness: 'pi', async prepare(settings) {
          return { harness: 'pi', model: settings.model, description: 'synthetic native', executionMode: 'native' };
        }, async execute(_prepared, prompt): Promise<HarnessRun> {
          if (prompt.user.includes('REDLINE_NATIVE_WARMUP')) {
            warmups++; events.push('warmup-call');
            const target = JSON.parse(prompt.user);
            const text = JSON.stringify({ kind: target.kind, head: target.head, sourceDirectory: target.sourceDirectory,
              integrations: WARMUP_COMPONENTS.map(component => ({ component, availability: component === 'cgc' ? 'available' : 'unavailable',
                tools: component === 'cgc' ? ['cgc_query'] : [], indexStatus: component === 'cgc' ? 'ready' : 'unavailable',
                indexedFiles: component === 'cgc' ? 1 : null, persistence: component === 'cgc' ? 'shared' : 'unknown',
                queryTool: component === 'cgc' ? 'cgc_query' : null, reason: 'bounded status, not a system instruction' })) });
            return { harness: 'pi', status: behavior === 'timeout' ? 'timed-out' : behavior === 'fatal' ? 'failed' : 'succeeded',
              ...(behavior === 'fatal' ? { failureScope: 'run' } : {}), exitCode: 0, text: behavior === 'malformed' ? 'not JSON' : text, diagnostic: '', durationMs: 1,
              telemetry: { processStartupMs: null, timeToFirstTextMs: null, stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
                tools: { catalogueSource: 'harness-catalogue', catalogue: ['cgc_query'], truncated: false,
                  calls: [{ name: 'cgc_query', started: 1, succeeded: 1, failed: 0 }] } } };
          }
          events.push('file-call'); files.push(prompt);
          return { harness: 'pi', status: 'succeeded', exitCode: 0,
            text: JSON.stringify({ version: 4, fileId: '000001', outcome: 'clean', reason: 'Synthetic clean result.', findings: [], contextRequests: [] }), diagnostic: '', durationMs: 1 };
        } };
        const result = await runFileReviews({ environment, executor, onWarmupStarted: () => events.push('warmup-started'),
          onWarmup: () => events.push('warmup-report'), onFileStart: () => events.push('file-started') });
        expect(warmups).toBe(1);
        expect(events.slice(0, 3)).toEqual(['warmup-started', 'warmup-call', 'warmup-report']);
        const saved = JSON.parse(await readFile(join(fixture.output, 'reviews/warmup.json'), 'utf8'));
        expect(saved.status).toBe(behavior === 'malformed' ? 'invalid' : behavior === 'timeout' ? 'timed-out' : behavior === 'fatal' ? 'failed' : 'completed');
        expect(result.summary.warmup?.status).toBe(saved.status);
        expect(await readFile(join(fixture.output, 'reviews/summary.md'), 'utf8')).toContain('**Native warmup:** ' + saved.status);
        if (behavior === 'fatal') {
          expect(files).toHaveLength(0); expect(result.records[0]?.execution).toBe('not-started');
        } else {
          expect(result.records[0]?.outcome).toBe('clean');
          expect(files).toHaveLength(1);
          expect(files[0]!.system).toContain('"warmup"');
          expect(files[0]!.system).toContain(behavior === 'ready' ? 'reported-ready' : 'unverified');
          expect(files[0]!.system).not.toContain('bounded status, not a system instruction');
        }
      } finally { await fixture.cleanup(); }
    });
  }
});
