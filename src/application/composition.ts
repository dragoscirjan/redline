import type { Layer } from 'effect';
import type { CodeContextProvider } from '../code-context/provider.ts';
import type { McpClient } from '../mcp/client.ts';
import type { ToolDispatcher } from '../mcp/tools.ts';
import type { ModelBindings } from '../model-runtime/bindings.ts';
import type { ModelConversation } from '../model-runtime/conversation.ts';
import type { ModelDriver } from '../model-runtime/types.ts';
import type { OperationalEvents } from '../observability/service.ts';
import type { ReviewEngine } from '../review/engine.ts';
import type { ReviewReuseStore } from '../review/reuse.ts';
import type { ReviewWriter } from '../review/writer.ts';
import type { RevisionSource } from '../revision-source/types.ts';
import type { RunBudget } from './budget.ts';
import type { ReviewConfiguration } from './configuration.ts';
import type { ReviewApplication } from './review.ts';
import type { WarmupService } from './warmup.ts';

export interface ReviewDependencies {
  readonly source: RevisionSource;
  readonly drivers: readonly ModelDriver[];
  readonly bindings: ModelBindings;
  readonly conversation: ModelConversation;
  readonly mcp: McpClient;
  readonly tools: ToolDispatcher;
  readonly warmup: WarmupService;
  readonly budget: RunBudget;
  readonly codeContext: CodeContextProvider;
  readonly engine: ReviewEngine;
  readonly writer: ReviewWriter;
  readonly reuse: ReviewReuseStore;
  readonly events: OperationalEvents;
}

export function createReviewLayer(configuration: ReviewConfiguration, dependencies: ReviewDependencies): Layer.Layer<ReviewApplication, Error> {
  // Compose one scoped application for CLI/RPC/container callers; share the budget and preserve binding-local SDK state.
  // Publication is composed separately so its credentials cannot reach model or tool services.
  throw new Error('Not implemented: createReviewLayer');
}
