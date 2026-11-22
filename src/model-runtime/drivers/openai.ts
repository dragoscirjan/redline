import { Effect } from 'effect';
import type { ModelCapabilities, ModelDriver, ModelRequest, ModelResponse, ResolvedModelBinding } from '../types.ts';

export class OpenAiDriver implements ModelDriver {
  generate(binding: ResolvedModelBinding, request: ModelRequest): Effect.Effect<ModelResponse, Error> {
    // Use the binding's native Chat Completions or Responses API, preserving reasoning, tools and continuation state.
    return Effect.fail(new Error('Not implemented: OpenAiDriver.generate'));
  }

  capabilities(binding: ResolvedModelBinding): Effect.Effect<ModelCapabilities, Error> {
    // Report the selected SDK/protocol controls without promising unsupported enforcement.
    return Effect.fail(new Error('Not implemented: OpenAiDriver.capabilities'));
  }
}
