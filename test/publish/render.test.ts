import { describe, expect, it } from 'vitest';
import {
  fileReviewMarker,
  findingMarker,
  renderFileReviewBody,
  renderFindingComment,
  renderSummaryBody,
  summaryMarker,
} from '../../src/publish/render.ts';
import type { FileReviewRecord, PublishedFinding } from '../../src/review/types.ts';
import type { ReviewScope } from '../../src/publish/types.ts';
import { publishedFinding, pullRequestReview } from '../helpers/finding.ts';
import { synthesizeReview } from '../../src/review/synthesis.ts';

const HEAD = 'b'.repeat(40);
const SCOPE: ReviewScope = { repository: 'owner/repository', pullRequest: 14, head: HEAD };
const DISABLED_CONTEXT = {
  status: 'disabled' as const,
  provider: null,
  revision: null,
  relatedSpans: 0,
  sourceBytes: 0,
  reason: 'not-configured' as const,
};

function finding(overrides: Partial<PublishedFinding> = {}): PublishedFinding {
  return publishedFinding({
    id: 'f-abc123',
    title: 'Missing guard returns the wrong value',
    severity: 'high',
    startLine: 3,
    endLine: 5,
    evidence: 'const value = compute(input);',
    impact: 'Wrong value returned.',
    fix: 'Restore the guard.',
    suggestion: '-const value = compute(input);\n+const value = guarded(input);',
    fixPrompt: 'Fix one code-review finding.\n\nLocation: src/example.ts:3-5',
    ...overrides,
  });
}

const RECORD: FileReviewRecord = {
  version: 4,
  fileId: '000001',
  path: 'src/example.ts',
  status: 'M',
  harness: 'pi',
  model: 'z-ai/glm-5.3-flash',
  codeContext: DISABLED_CONTEXT,
  outcome: 'findings',
  findings: [finding()],
  rejectedCandidates: [],
  durationMs: 900,
};

const REVIEW = pullRequestReview({
  model: 'z-ai/glm-5.3-flash',
  provider: 'openrouter',
  head: HEAD,
  findings: [{ ...finding(), triggerFileId: '000001', triggerPath: 'src/example.ts' }],
  verdict: { status: 'blocked', reasons: ['f-abc123: unresolved high defect'] },
  files: [
    {
      fileId: '000001',
      path: 'src/example.ts',
      outcome: 'findings',
      findingIds: ['f-abc123'],
      rejectedCandidates: 0,
      codeContext: DISABLED_CONTEXT,
    },
    {
      fileId: '000002',
      path: 'src/other.ts',
      outcome: 'clean',
      findingIds: [],
      rejectedCandidates: 0,
      codeContext: DISABLED_CONTEXT,
    },
  ],
});

describe('markers', () => {
  it('embeds scope and ownership into machine-readable markers', () => {
    expect(summaryMarker(SCOPE)).toBe('<!-- redline:summary:v2 repository=owner%2Frepository pr=14 -->');
    expect(fileReviewMarker(SCOPE, '000001')).toBe(`<!-- redline:file:v1 file=000001 head=${HEAD} -->`);
    expect(findingMarker(SCOPE, 'f-abc')).toBe(`<!-- redline:finding:v1 id=f-abc head=${HEAD} -->`);
  });
});

describe('renderFindingComment', () => {
  it('renders explanation, GitHub-format suggestion block, fix prompt, and the marker', () => {
    const body = renderFindingComment(SCOPE, 'src/example.ts', finding());
    expect(body).toContain('**Missing guard returns the wrong value** — `src/example.ts:3-5` (side RIGHT)');
    expect(body).toContain('- **Evidence (line 3):** `const value = compute(input);`');
    expect(body).toContain('- **Impact:** Wrong value returned.');
    expect(body).toContain('**Suggested change** (apply-able):');
    // GitHub suggestion blocks replace the anchored span with the block
    // content verbatim: only the replacement lines, no `-`/`+` markers.
    expect(body).toContain('```suggestion\nconst value = guarded(input);\n```');
    expect(body).not.toContain('-const value = compute(input);\n+');
    expect(body).toContain('<details><summary>Fix prompt for a coding agent</summary>');
    expect(body).toContain('```text\nFix one code-review finding.');
    expect(body.trimEnd().split('\n').at(-1)).toBe(findingMarker(SCOPE, 'f-abc123'));
  });

  it('omits the suggestion block when the finding carries none', () => {
    const body = renderFindingComment(SCOPE, 'src/example.ts', finding({ suggestion: undefined }));
    expect(body).not.toContain('```suggestion');
    expect(body).toContain('Fix prompt');
  });

  it('keeps delete-only proposals as a diff quote instead of an apply-able block', () => {
    const body = renderFindingComment(SCOPE, 'src/example.ts', finding({ suggestion: '-const value = compute(input);' }));
    expect(body).toContain('**Suggested change** (delete-only; apply manually):');
    expect(body).toContain('```diff\n-const value = compute(input);\n```');
    expect(body).not.toContain('suggestion');
  });

  it('extends the fence when the content contains triple backticks', () => {
    const body = renderFindingComment(
      SCOPE,
      'docs/example.md',
      finding({ fixPrompt: 'Fix one code-review finding.\n\nContext:\n```\ninline code fence\n```' }),
    );
    expect(body).toContain('````text\nFix one code-review finding.');
    expect(body).toContain('````\n\n</details>');
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
  it('shows every consolidated changed-line trigger and a critical budget omission without inline duplication', () => {
    const support = [{ role: 'contract' as const, revision: HEAD, path: 'src/shared.ts',
      startLine: 1, endLine: 1, evidence: 'shared();' }];
    const findings = [
      { ...finding({ id: 'f-first', severity: 'critical', supportingEvidence: support,
        verification: { status: 'confirmed' as const, reason: 'checked' } }),
        triggerFileId: '000001', triggerPath: 'src/example.ts' },
      { ...finding({ id: 'f-second', severity: 'high', supportingEvidence: support,
        verification: { status: 'confirmed' as const, reason: 'checked' } }),
        triggerFileId: '000002', triggerPath: 'src/other.ts' },
    ];
    const synthesis = synthesizeReview(findings, { fileReviews: 0, inlineComments: 0 });
    const body = renderSummaryBody(SCOPE, { ...REVIEW, findings, synthesis,
      limitations: [{ code: 'critical-publication-suppressed', required: true,
        message: '1 critical finding exceeded the budget.' }],
    }, { publishedFileReviews: 0, failedFileReviews: 0, failedInlineComments: 0 });
    expect(body).toContain('1 duplicate comments consolidated; 1 findings withheld');
    expect(body).toContain('`src/example.ts:3-5`, `src/other.ts:3-5`');
    expect(body).toContain('f-first` — file-budget');
    expect(body).toContain('Required — 1 critical finding exceeded the budget.');
  });

  it('renders run counts, per-file outcomes, and publication notes', () => {
    const body = renderSummaryBody(SCOPE, REVIEW, { publishedFileReviews: 1, failedFileReviews: 0, failedInlineComments: 0 });
    expect(body).toContain('## Redline pull request review');
    expect(body).toContain('- **Verdict:** blocked');
    expect(body).toContain('- **Files:** 2 required reviews · 0 omitted · 0 excluded by trusted policy');
    expect(body).toContain('- **Findings:** 1');
    expect(body).toContain('- `src/example.ts`: findings — 1 finding(s)');
    expect(body).toContain('- `src/other.ts`: clean');
    expect(body).toContain('**Publication:** 1 file review published.');
    expect(body.trimEnd().split('\n').at(-1)).toBe(summaryMarker(SCOPE));
  });

  it('lists every trusted-policy exclusion with its reason', () => {
    const review = {
      ...REVIEW,
      coverage: {
        ...REVIEW.coverage,
        files: {
          ...REVIEW.coverage.files,
          excluded: ['benchmark/example/capture.json'],
          excludedDetails: [{ fileId: '000003', path: 'benchmark/example/capture.json', reason: 'generated raw benchmark capture' }],
        },
      },
    };
    const body = renderSummaryBody(SCOPE, review, {
      publishedFileReviews: 0, failedFileReviews: 0, failedInlineComments: 0,
    });
    expect(body).toContain('1 excluded by trusted policy');
    expect(body).toContain('`benchmark/example/capture.json` — generated raw benchmark capture');
  });

  it('reports publication failures when present', () => {
    const body = renderSummaryBody(SCOPE, REVIEW, { publishedFileReviews: 0, failedFileReviews: 2, failedInlineComments: 3 });
    expect(body).toContain('**Publication:** no file reviews to publish.');
    expect(body).toContain('**Publication failures:** 2 file reviews, 3 inline comments.');
  });
});
