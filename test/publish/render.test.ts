import { describe, expect, it } from 'vitest';
import {
  fileReviewMarker,
  findingMarker,
  renderFileReviewBody,
  renderFindingComment,
  renderSummaryBody,
  summaryMarker,
} from '../../src/publish/render.js';
import type { FileReviewRecord, PublishedFinding, ReviewRunSummary } from '../../src/review/types.js';
import type { ReviewScope } from '../../src/publish/types.js';

const HEAD = 'b'.repeat(40);
const SCOPE: ReviewScope = { repository: 'owner/repository', pullRequest: 14, head: HEAD };

function finding(overrides: Partial<PublishedFinding> = {}): PublishedFinding {
  return {
    id: 'f-abc123',
    category: 'correctness',
    classification: 'defect',
    severity: 'high',
    confidence: 0.9,
    side: 'RIGHT',
    startLine: 3,
    endLine: 5,
    evidence: 'const value = compute(input);',
    impact: 'Wrong value returned.',
    fix: 'Restore the guard.',
    suggestion: '-const value = compute(input);\n+const value = guarded(input);',
    fixPrompt: 'Fix one code-review finding.\n\nLocation: src/example.ts:3-5',
    ...overrides,
  };
}

const RECORD: FileReviewRecord = {
  version: 2,
  fileId: '000001',
  path: 'src/example.ts',
  status: 'M',
  harness: 'pi',
  model: 'z-ai/glm-5.3-flash',
  outcome: 'findings',
  findings: [finding()],
  durationMs: 900,
};

const SUMMARY: ReviewRunSummary = {
  version: 2,
  harness: 'pi',
  model: 'z-ai/glm-5.3-flash',
  provider: 'openrouter',
  findingScope: 'defects',
  base: 'a'.repeat(40),
  head: HEAD,
  manifestFiles: 3,
  reviewedFiles: 2,
  omittedFiles: 0,
  findings: 1,
  files: [
    { fileId: '000001', path: 'src/example.ts', outcome: 'findings', findingCount: 1, findingSpans: ['3-5'] },
    { fileId: '000002', path: 'src/other.ts', outcome: 'clean', findingCount: 0, findingSpans: [] },
  ],
};

describe('markers', () => {
  it('embeds scope and ownership into machine-readable markers', () => {
    expect(summaryMarker(SCOPE)).toBe('<!-- redline:summary:v2 repository=owner%2Frepository pr=14 -->');
    expect(fileReviewMarker(SCOPE, '000001')).toBe(`<!-- redline:file:v1 file=000001 head=${HEAD} -->`);
    expect(findingMarker(SCOPE, 'f-abc')).toBe(`<!-- redline:finding:v1 id=f-abc head=${HEAD} -->`);
  });
});

describe('renderFindingComment', () => {
  it('renders explanation, suggestion block, fix prompt, and the finding marker', () => {
    const body = renderFindingComment(SCOPE, 'src/example.ts', finding());
    expect(body).toContain('**high defect (correctness)** — `src/example.ts:3-5` (side RIGHT), confidence 0.9');
    expect(body).toContain('- **Evidence (line 3):** `const value = compute(input);`');
    expect(body).toContain('- **Impact:** Wrong value returned.');
    expect(body).toContain('**Suggested change** (apply-able):');
    expect(body).toContain('```suggestion\n-const value = compute(input);\n+const value = guarded(input);\n```');
    expect(body).toContain('<details><summary>Fix prompt for a coding agent</summary>');
    expect(body).toContain('```text\nFix one code-review finding.');
    expect(body.trimEnd().split('\n').at(-1)).toBe(findingMarker(SCOPE, 'f-abc123'));
  });

  it('omits the suggestion block when the finding carries none', () => {
    const body = renderFindingComment(SCOPE, 'src/example.ts', finding({ suggestion: undefined }));
    expect(body).not.toContain('```suggestion');
    expect(body).toContain('Fix prompt');
  });
});

describe('renderFileReviewBody', () => {
  it('renders the file record with spans and ends with the file marker', () => {
    const body = renderFileReviewBody(SCOPE, RECORD);
    expect(body).toContain('## Redline review: src/example.ts');
    expect(body).toContain('- **File id:** 000001');
    expect(body).toContain('- **Outcome:** findings — 1 validated finding');
    expect(body).toContain('`src/example.ts:3-5`');
    expect(body.trimEnd().split('\n').at(-1)).toBe(fileReviewMarker(SCOPE, '000001'));
  });
});

describe('renderSummaryBody', () => {
  it('renders run counts, per-file outcomes, and publication notes', () => {
    const body = renderSummaryBody(SCOPE, SUMMARY, { publishedFileReviews: 1, failedFileReviews: 0, failedInlineComments: 0 });
    expect(body).toContain('## Redline review summary');
    expect(body).toContain('- **Files:** 3 in the manifest · 2 reviewed · 0 omitted');
    expect(body).toContain('- **Findings:** 1');
    expect(body).toContain('- `src/example.ts`: findings — `3-5`');
    expect(body).toContain('- `src/other.ts`: clean');
    expect(body).toContain('**Publication:** 1 file review published.');
    expect(body.trimEnd().split('\n').at(-1)).toBe(summaryMarker(SCOPE));
  });

  it('reports publication failures when present', () => {
    const body = renderSummaryBody(SCOPE, SUMMARY, { publishedFileReviews: 0, failedFileReviews: 2, failedInlineComments: 3 });
    expect(body).toContain('**Publication:** no file reviews to publish.');
    expect(body).toContain('**Publication failures:** 2 file reviews, 3 inline comments.');
  });
});
