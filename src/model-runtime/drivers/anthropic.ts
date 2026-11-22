import { Effect } from 'effect';
import type { ModelCapabilities, ModelDriver, ModelRequest, ModelResponse, ResolvedModelBinding } from '../types.ts';

export class AnthropicDriver implements ModelDriver {
  generate(binding: ResolvedModelBinding, request: ModelRequest): Effect.Effect<ModelResponse, Error> {
    // Use native Messages semantics and binding-local tools, reasoning and continuation state.
    return Effect.fail(new Error('Not implemented: AnthropicDriver.generate'));
  }

  capabilities(binding: ResolvedModelBinding): Effect.Effect<ModelCapabilities, Error> {
    // Describe the selected SDK and model without routing through an OpenAI compatibility shim.
    return Effect.fail(new Error('Not implemented: AnthropicDriver.capabilities'));
  }
}
