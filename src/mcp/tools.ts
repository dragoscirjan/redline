import { Effect, type Scope } from 'effect';
import type { RunBudget } from '../application/budget.ts';
import type { ExecutionProfile } from '../application/configuration.ts';
import type { CapturedRevision } from '../revision-source/types.ts';
import type { McpClient } from './client.ts';

export type ReviewToolCall = unknown;
export type ReviewToolResult = unknown;

export interface ToolExecutionContext {
  readonly capture: CapturedRevision;
  readonly profile: ExecutionProfile;
  readonly budget: RunBudget;
  readonly mcp: McpClient;
}

export class ToolDispatcher {
  call(request: ReviewToolCall, context: ToolExecutionContext): Effect.Effect<ReviewToolResult, Error, Scope.Scope> {
    // Dispatch captured-source tools and configured MCP tools under explicit profile permissions and the shared budget.
    // Do not impose a universal local/Docker allowlist or expose publication credentials.
    return Effect.fail(new Error('Not implemented: ToolDispatcher.call'));
  }
}
