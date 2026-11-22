import { Effect } from 'effect';
import type { ModelCapabilities, ModelDriver, ModelRequest, ModelResponse, ResolvedModelBinding } from '../types.ts';

export class GeminiDriver implements ModelDriver {
  generate(binding: ResolvedModelBinding, request: ModelRequest): Effect.Effect<ModelResponse, Error> {
    // Use native generateContent/streaming semantics; preserve provider state rather than translating through OpenAI.
    return Effect.fail(new Error('Not implemented: GeminiDriver.generate'));
  }

  capabilities(binding: ResolvedModelBinding): Effect.Effect<ModelCapabilities, Error> {
    // Describe the selected SDK's actual controls without mixing incompatible Effect release families.
    return Effect.fail(new Error('Not implemented: GeminiDriver.capabilities'));
  }
}
