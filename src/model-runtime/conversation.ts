import { Effect, type Scope } from 'effect';
import type { RunBudget } from '../application/budget.ts';
import type { ToolDispatcher, ToolExecutionContext } from '../mcp/tools.ts';
import type { ConversationRequest, ConversationResult, ModelDriver, ResolvedModelBinding } from './types.ts';

export interface ConversationContext {
  readonly driver: ModelDriver;
  readonly tools: ToolDispatcher;
  readonly toolContext: ToolExecutionContext;
  readonly budget: RunBudget;
}

export class ModelConversation {
  run(binding: ResolvedModelBinding, request: ConversationRequest, context: ConversationContext): Effect.Effect<ConversationResult, Error, Scope.Scope> {
    // Own one bounded model/tool conversation with Effect lifecycle, deadlines and retry accounting.
    // Keep native state binding-local; do not add another SDK agent loop or move conversations between drivers.
    return Effect.fail(new Error('Not implemented: ModelConversation.run'));
  }
}
