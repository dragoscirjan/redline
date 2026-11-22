import { Effect, type Scope } from 'effect';
import type { RunBudget } from '../application/budget.ts';
import type { ReviewConfiguration } from '../application/configuration.ts';
import type { CodeContextProvider } from '../code-context/provider.ts';
import type { ModelBindings } from '../model-runtime/bindings.ts';
import type { ModelConversation, ConversationContext } from '../model-runtime/conversation.ts';
import type { ModelDriver } from '../model-runtime/types.ts';
import type { CapturedRevision } from '../revision-source/types.ts';
import type { CandidateValidationResult, FileReviewValidator } from './report.ts';
import type { FileReviewInput, ReviewDocument } from './types.ts';

export interface ReviewEngineContext {
  readonly configuration: ReviewConfiguration;
  readonly drivers: readonly ModelDriver[];
  readonly bindings: ModelBindings;
  readonly conversation: ModelConversation;
  readonly conversationContext: ConversationContext;
  readonly codeContext: CodeContextProvider;
  readonly validator: FileReviewValidator;
  readonly budget: RunBudget;
}

export class ReviewEngine {
  reviewFile(input: FileReviewInput, context: ReviewEngineContext): Effect.Effect<CandidateValidationResult, Error, Scope.Scope> {
    // Run the fixed per-file prompt through its selected binding, then validate every candidate against authoritative evidence.
    return Effect.fail(new Error('Not implemented: ReviewEngine.reviewFile'));
  }

  reviewChange(capture: CapturedRevision, context: ReviewEngineContext): Effect.Effect<ReviewDocument, Error, Scope.Scope> {
    // Bound file concurrency and retries, preserve omissions/coverage and synthesize one coherent JSON result across mixed drivers.
    return Effect.fail(new Error('Not implemented: ReviewEngine.reviewChange'));
  }
}
