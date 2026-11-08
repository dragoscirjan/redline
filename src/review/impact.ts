/** Native impact notes are separate from findings; every caller citation is re-read from captured source. */
import { validateSourceEvidence } from './source-evidence.ts';
import type { ReviewBundle } from './bundle.ts';
import type { SourceEvidence } from './types.ts';
import type { NativeToolEvidence } from '../harness-executor/native.ts';
import type { WarmupGuidance } from './warmup.ts';

export interface FileImpactAnalysis {
  readonly status: 'checked' | 'partial' | 'not-applicable';
  readonly changedSymbols: readonly string[];
  readonly callers: readonly SourceEvidence[];
  readonly summary: string;
  readonly limitation: string;
  readonly indexQueryObserved: boolean;
}
/** Reject non-record model output before checking the impact schema. */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Bound model-supplied impact text before accepting it into persisted reports. */
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}
/** Validate caller citations against captured head source and downgrade indexed coverage when no successful per-file query was observed. */
export async function extractNativeImpact(rawText: string, bundle: ReviewBundle, warmup: WarmupGuidance | undefined,
  evidence: NativeToolEvidence | undefined): Promise<{ text: string; impactAnalysis: FileImpactAnalysis }> {
  const raw: unknown = JSON.parse(rawText);
  if (!object(raw) || !object(raw.impactAnalysis)) throw new Error('native review requires impactAnalysis');
  const value = raw.impactAnalysis;
  const keys = ['status', 'changedSymbols', 'callers', 'summary', 'limitation'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || !['checked', 'partial', 'not-applicable'].includes(String(value.status))
    || !Array.isArray(value.changedSymbols) || value.changedSymbols.length > 32
    || !value.changedSymbols.every(symbol => text(symbol, 160) && symbol.length > 0)
    || !Array.isArray(value.callers) || value.callers.length > 16
    || !text(value.summary, 2000) || !text(value.limitation, 500)) throw new Error('invalid native impactAnalysis');
  const callers: SourceEvidence[] = [];
  for (const item of value.callers) {
    if (!object(item) || Object.keys(item).length !== 6
      || !text(item.role, 40) || !['missing-guard', 'caller-assumption', 'contract', 'schema', 'test-gap', 'impact-path'].includes(item.role)
      || !text(item.path, 4096) || !text(item.revision, 64) || item.revision !== bundle.manifest.head || !text(item.evidence, 8192)
      || !Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine)) throw new Error('invalid native impact caller citation');
    const citation: SourceEvidence = { role: item.role as SourceEvidence['role'], path: item.path, revision: item.revision,
      startLine: Number(item.startLine), endLine: Number(item.endLine), evidence: item.evidence };
    await validateSourceEvidence(bundle, citation);
    callers.push(citation);
  }
  if (value.status === 'partial' && value.limitation.length === 0) throw new Error('partial impact analysis requires a limitation');
  if (value.status === 'not-applicable' && (value.changedSymbols.length > 0 || callers.length > 0)) throw new Error('not-applicable impact analysis cannot claim changed symbols or callers');
  const indexer = warmup?.integrations.find(row => row.category === 'indexer' && row.indexStatus === 'reported-ready');
  const queryTool = indexer?.category === 'indexer' ? indexer.queryTool : undefined;
  const indexQueryObserved = typeof queryTool === 'string' && evidence?.calls.some(call => call.name === queryTool && call.succeeded > 0) === true;
  const missingQuery = indexer !== undefined && !indexQueryObserved && value.status === 'checked';
  const review = { ...raw }; delete review.impactAnalysis;
  return { text: JSON.stringify(review), impactAnalysis: {
    status: missingQuery ? 'partial' : value.status as FileImpactAnalysis['status'], changedSymbols: value.changedSymbols, callers,
    summary: missingQuery ? 'The selected indexer query was not observed in this file process; indexed impact checking is incomplete.' : value.summary,
    limitation: missingQuery ? 'No successful selected-indexer query was observed. Caller citations do not prove complete caller coverage.' : value.limitation,
    indexQueryObserved,
  } };
}
