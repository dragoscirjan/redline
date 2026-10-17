import { createHash } from 'node:crypto';
import { MAX_PUBLISHED_FILE_REVIEWS, MAX_PUBLISHED_INLINE_COMMENTS } from './publication-limits.js';
import type { PullRequestFinding, ReviewSynthesis, ReviewSynthesisDecision, ReviewSynthesisGroup } from './types.js';

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function evidenceAnchor(finding: PullRequestFinding): readonly string[] {
  const supporting = finding.supportingEvidence.map((source) =>
    JSON.stringify([source.revision, source.path, source.startLine, source.evidence]));
  return [JSON.stringify([
    finding.triggerPath, finding.side, finding.startLine, finding.endLine, finding.evidence,
  ]), ...supporting];
}

function score(finding: PullRequestFinding): readonly number[] {
  const severity = { critical: 4, high: 3, medium: 2, low: 1 }[finding.severity];
  const reversibility = { irreversible: 3, 'partially-reversible': 2, unknown: 1, reversible: 0 }[finding.reversibility];
  const evidence = Math.min(8, finding.supportingEvidence.length) +
    (finding.impactPath.status === 'complete' ? 2 : finding.impactPath.status === 'partial' ? 1 : 0);
  return [severity, reversibility, evidence, Math.min(0.95, Math.max(0, finding.confidence))];
}

/** Higher consequence, then bounded source strength, then stable identity. */
function compare(left: PullRequestFinding, right: PullRequestFinding): number {
  const a = score(left);
  const b = score(right);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return b[i]! - a[i]!;
  }
  return left.triggerFileId.localeCompare(right.triggerFileId, 'en') || left.id.localeCompare(right.id, 'en');
}

function groupId(findings: readonly PullRequestFinding[]): string {
  const identities = findings.map((item) => `${item.triggerFileId}:${item.id}`).sort();
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex').slice(0, 24);
}

/** Source-backed duplicate grouping and bounded publication eligibility. */
export function synthesizeReview(
  findings: readonly PullRequestFinding[],
  budgets: { readonly fileReviews: number; readonly inlineComments: number } = {
    fileReviews: MAX_PUBLISHED_FILE_REVIEWS, inlineComments: MAX_PUBLISHED_INLINE_COMMENTS,
  },
): ReviewSynthesis {
  if (!Number.isSafeInteger(budgets.fileReviews) || budgets.fileReviews < 0 ||
      budgets.fileReviews > MAX_PUBLISHED_FILE_REVIEWS ||
      !Number.isSafeInteger(budgets.inlineComments) || budgets.inlineComments < 0 ||
      budgets.inlineComments > MAX_PUBLISHED_INLINE_COMMENTS) {
    throw new Error('publication budgets must not exceed the fixed action caps');
  }
  const ordered = [...findings].sort(compare);
  const parents = ordered.map((_, index) => index);
  const root = (index: number): number => {
    let current = index;
    while (parents[current] !== current) current = parents[current]!;
    return current;
  };
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const left = ordered[i]!;
      const right = ordered[j]!;
      if (normalize(left.rootCause) !== normalize(right.rootCause)) continue;
      const anchors = new Set(evidenceAnchor(left));
      if (!evidenceAnchor(right).some((anchor) => anchors.has(anchor))) continue;
      const a = root(i);
      const b = root(j);
      if (a !== b) parents[b] = a;
    }
  }
  const clusters = new Map<number, PullRequestFinding[]>();
  for (let index = 0; index < ordered.length; index += 1) {
    const key = root(index);
    const cluster = clusters.get(key) ?? [];
    cluster.push(ordered[index]!);
    clusters.set(key, cluster);
  }
  const groups: ReviewSynthesisGroup[] = [];
  const decisions: ReviewSynthesisDecision[] = [];
  const usedFiles = new Set<string>();
  let usedComments = 0;
  for (const cluster of clusters.values()) {
    const members = cluster.sort(compare);
    const primary = members[0]!;
    const id = groupId(members);
    const contracts = new Set(members.map((finding) => normalize(finding.behavioralContract)));
    const classifications = new Set(members.map((finding) => finding.classification));
    const conflict = contracts.size > 1 || classifications.size > 1;
    const source = new Map<string, PullRequestFinding['supportingEvidence'][number]>();
    for (const finding of members) {
      for (const evidence of finding.supportingEvidence) {
        source.set(JSON.stringify(evidence), evidence);
      }
    }
    groups.push({
      id, rootCause: primary.rootCause, status: conflict ? 'conflict' : 'coherent',
      triggers: members.map((finding) => ({ fileId: finding.triggerFileId, findingId: finding.id,
        path: finding.triggerPath, side: finding.side, startLine: finding.startLine, endLine: finding.endLine })),
      supportingEvidence: [...source.values()],
      representative: conflict ? null : { fileId: primary.triggerFileId, findingId: primary.id },
    });
    for (const finding of members) {
      let status: ReviewSynthesisDecision['status'];
      if (conflict) status = 'conflict';
      else if (finding !== primary) status = 'duplicate';
      else if (finding.verification.status !== 'confirmed') status = 'unverified';
      else if (!usedFiles.has(finding.triggerFileId) && usedFiles.size >= budgets.fileReviews) status = 'file-budget';
      else if (usedComments >= budgets.inlineComments) status = 'comment-budget';
      else {
        status = 'publish';
        usedFiles.add(finding.triggerFileId);
        usedComments += 1;
      }
      decisions.push({ fileId: finding.triggerFileId, findingId: finding.id, groupId: id, status,
        reason: {
          publish: 'highest-ranked confirmed source-backed representative',
          duplicate: 'same source-backed root cause is represented by another changed-line trigger',
          conflict: 'source-backed claims disagree about the behavioral contract; human review required',
          unverified: 'the representative lacks independent confirmation',
          'file-budget': 'file review publication cap reached after ranking',
          'comment-budget': 'inline comment publication cap reached after ranking',
        }[status],
      });
    }
  }
  return { version: 1, groups, decisions, budgets };
}
