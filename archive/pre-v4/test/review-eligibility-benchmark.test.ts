import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildReviewEligibilityReport,
  parseReviewEligibilityCapture,
  renderReviewEligibilityReport,
} from '../src/benchmark/review-eligibility.ts';

const CAPTURE = 'benchmark/review-eligibility/v1/capture.json';

describe('review eligibility benchmark', () => {
  it('supports only the measured raw capture default', async () => {
    const capture = parseReviewEligibilityCapture(JSON.parse(await readFile(CAPTURE, 'utf8')) as unknown);
    const report = buildReviewEligibilityReport(capture);
    expect(report.selectedDefaults).toEqual(['benchmark/**/capture.json']);
    expect(report.classes).toContainEqual(expect.objectContaining({
      id: 'benchmark-capture',
      observedFiles: 1,
      diffBytes: 63_669,
      estimatedInputTokens: 15_918,
      modelDurationMs: 3_987,
      findings: 0,
      recommendation: 'exclude-by-default',
    }));
    expect(report.classes).toContainEqual(expect.objectContaining({
      id: 'benchmark-report', recommendation: 'keep-reviewable', observedFiles: 2,
    }));
    expect(report.classes).toContainEqual(expect.objectContaining({
      id: 'generated-snapshot', recommendation: 'insufficient-evidence', observedFiles: 0,
    }));
    expect(renderReviewEligibilityReport(report)).toContain('Generated snapshots were not observed');
  });

  it('does not recommend a default from omitted review evidence', () => {
    const capture = parseReviewEligibilityCapture({
      version: 1,
      kind: 'review-eligibility-observation',
      capturedAt: '2026-01-01T00:00:00.000Z',
      repository: 'owner/repo',
      pullRequest: 1,
      runId: 1,
      runUrl: 'https://example.invalid/run/1',
      head: 'a'.repeat(40),
      run: { files: 1, diffBytes: 100, modelDurationMs: 10, findings: 0, omitted: 1 },
      classes: [{
        id: 'capture',
        pattern: 'capture.json',
        candidateDefault: true,
        files: [{
          path: 'capture.json', diffBytes: 100, modelDurationMs: 10,
          outcome: 'omitted', findings: 0, rejectedCandidates: 0,
        }],
      }],
    });
    expect(buildReviewEligibilityReport(capture).selectedDefaults).toEqual([]);
  });

  it('rejects unknown capture fields', () => {
    expect(() => parseReviewEligibilityCapture({
      version: 1,
      kind: 'review-eligibility-observation',
      capturedAt: 'now',
      repository: 'owner/repo',
      pullRequest: 1,
      runId: 1,
      runUrl: 'https://example.invalid',
      head: 'a'.repeat(40),
      run: { files: 0, diffBytes: 0, modelDurationMs: 0, findings: 0, omitted: 0 },
      classes: [],
      extra: true,
    })).toThrow(/unknown key/u);
  });
});
