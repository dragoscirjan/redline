import { Effect, type Scope } from 'effect';
import type { CodeContextProvider } from '../code-context/provider.ts';
import type { ToolDispatcher, ToolExecutionContext } from '../mcp/tools.ts';
import type { ModelBindings } from '../model-runtime/bindings.ts';
import type { ModelConversation } from '../model-runtime/conversation.ts';
import type { ModelDriver } from '../model-runtime/types.ts';
import type { RunBudget } from './budget.ts';

export type WarmupRequest = unknown;
export type WarmupReport = unknown;
export interface WarmupContext {
  readonly drivers: readonly ModelDriver[];
  readonly bindings: ModelBindings;
  readonly conversation: ModelConversation;
  readonly tools: ToolDispatcher;
  readonly toolContext: ToolExecutionContext;
  readonly codeContext: CodeContextProvider;
  readonly budget: RunBudget;
}

export class WarmupService {
  run(request: WarmupRequest, context: WarmupContext): Effect.Effect<WarmupReport, Error, Scope.Scope> {
    // Retain model-driven warmup; distinguish assertions, discovery, observed calls and successful indexing/query evidence.
    // Respect selected/required indexing and optional MCP warnings without consuming a separate unbounded budget.
    return Effect.fail(new Error('Not implemented: WarmupService.run'));
  }
}
