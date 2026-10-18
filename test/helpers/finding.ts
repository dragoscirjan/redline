import type {
  PublishedFinding,
  PullRequestReviewRecord,
  ReviewFinding,
} from '../../src/review/types.js';

export function reviewFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: 'Changed behavior can return the wrong result',
    dimensions: ['correctness'],
    category: 'correctness',
    classification: 'defect',
    severity: 'medium',
    confidence: 0.9,
    side: 'RIGHT',
    startLine: 1,
    endLine: 1,
    evidence: 'const value = next();',
    supportingEvidence: [],
    graphReferences: [],
    impactPath: {
      status: 'unresolved',
      steps: [],
      limitation: 'No validated impact path was supplied.',
    },
    behavioralContract: 'The changed function must preserve its documented result.',
    failureScenario: 'A supported input reaches the changed path and returns the wrong result.',
    reachability: 'The changed function is called by the public entry point.',
    rootCause: 'The change removes the required guard.',
    impact: 'Callers receive an incorrect value.',
    blastRadius: 'All callers using the supported input are affected.',
    reversibility: 'reversible',
    assumptions: [],
    counterEvidence: [],
    uncertainty: 'No material uncertainty remains in the cited path.',
    fix: 'Restore the required guard.',
    regressionTest: 'Exercise the supported input; fail before the fix and pass after it.',
    verification: { status: 'unverified', reason: 'Independent verification has not run.' },
    remediationStatus: 'guidance',
    ...overrides,
  };
}

export function publishedFinding(overrides: Partial<PublishedFinding> = {}): PublishedFinding {
  return {
    ...reviewFinding(),
    id: 'f-1234567890abcdef12345678',
    fixPrompt: 'Apply the smallest verified correction.',
    ...overrides,
  };
}

export function pullRequestReview(
  overrides: Partial<PullRequestReviewRecord> = {},
): PullRequestReviewRecord {
  return {
    version: 2,
    harness: 'pi',
    model: 'test-model',
    provider: 'mock',
    findingScope: 'defects',
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    findings: [],
    rejectedCandidates: [],
    coverage: {
      files: { status: 'completed', required: true, reason: 'all files reviewed', considered: [], omitted: [], excluded: [] },
      changedSymbols: { status: 'unavailable', required: false, reason: 'not produced' },
      contextSources: [
        { source: 'diff', status: 'completed', required: true, reason: 'loaded' },
      ],
      specialists: [
        { id: 'baseline-file-review', status: 'completed', required: true, reason: 'completed' },
      ],
      inspections: [],
      codeIntelligence: {
        status: 'not-applicable',
        required: false,
        reason: 'disabled',
        provider: null,
        baseSnapshot: 'a'.repeat(40),
        headSnapshot: 'b'.repeat(40),
        capabilities: [],
        cache: 'not-applicable',
        diagnostics: [],
      },
      graphQueries: [{ status: 'not-applicable', required: false, reason: 'disabled' }],
      impactTraversals: [{ status: 'not-applicable', required: false, reason: 'disabled' }],
      relationships: {
        sourceConfirmed: 0,
        providerDerived: 0,
        providerDisagreement: [],
        unresolvedSymbols: [],
        unsupportedLanguages: [],
        dynamicBehaviorUncertainty: ['Dynamic behavior was not evaluated.'],
      },
      truncation: { status: 'completed', required: false, reason: 'none' },
      rejectedCandidates: 0,
      remediation: { status: 'completed', required: false, reason: 'available' },
      fixVerification: { status: 'not-applicable', required: false, reason: 'no findings' },
      budgets: { maximumFindingsPerFile: 10, indexedContextBytes: 0, indexedContextSpans: 0 },
    },
    limitations: [],
    verdict: { status: 'mergeable', reasons: ['complete'] },
    files: [],
    legacySummaryVersion: 3,
    ...overrides,
  };
}
