import { Effect } from 'effect';
import type { ReviewConfiguration } from '../application/configuration.ts';
import type { CredentialReference, ModelDriver, ModelRole, ResolvedModelBinding, SelectedCredential } from './types.ts';

export class ModelBindings {
  resolve(role: ModelRole, configuration: ReviewConfiguration, drivers: readonly ModelDriver[]): Effect.Effect<ResolvedModelBinding, Error> {
    // Select an explicit driver/protocol/provider/model binding without implicit failover or cross-driver state transfer.
    return Effect.fail(new Error('Not implemented: ModelBindings.resolve'));
  }

  resolveCredential(reference: CredentialReference): Effect.Effect<SelectedCredential, Error> {
    // Resolve only the selected model credential from trusted configuration; never expose it to artifacts or publishers.
    return Effect.fail(new Error('Not implemented: ModelBindings.resolveCredential'));
  }
}
