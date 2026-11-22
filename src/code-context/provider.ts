import { Effect } from 'effect';
import type { ToolDispatcher, ToolExecutionContext } from '../mcp/tools.ts';

/** Existing provider-neutral graph evidence contract, copied without runtime indexing code. */
export interface CodeContextGraphReference {
  provider: string;
  providerVersion: string;
  snapshotRevision: string;
  capability: string;
  query: string;
  relationship: string;
  resolution: 'exact' | 'approximate' | 'unresolved';
  graphFactDigest: `sha256:${string}`;
}
export type FollowUpDirection = 'incoming' | 'outgoing';
export type CodeContextSelection = unknown;
export type CodeContextRequest = unknown;
export type CodeContextResult = unknown;
export type IndexObservation = unknown;

export interface CodeContextExecutionContext {
  readonly tools: ToolDispatcher;
  readonly toolContext: ToolExecutionContext;
}

export class CodeContextProvider {
  prepare(selection: CodeContextSelection, context: CodeContextExecutionContext): Effect.Effect<IndexObservation, Error> {
    // Respect selected/disabled/required indexing, reuse provider-owned state and verify with an observed query.
    // Do not substitute providers, install tools or restore the retired host-indexing pipeline.
    return Effect.fail(new Error('Not implemented: CodeContextProvider.prepare'));
  }

  resolve(request: CodeContextRequest, context: CodeContextExecutionContext): Effect.Effect<CodeContextResult, Error> {
    // Verify repository/head identity and re-resolve bounded related spans from captured source, recording file-only degradation.
    return Effect.fail(new Error('Not implemented: CodeContextProvider.resolve'));
  }
}
