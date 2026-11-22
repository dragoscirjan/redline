import type { Effect } from 'effect';

/** Protocol, SDK family, endpoint and role are separate concepts; their payload schemas remain undecided. */
export type ModelProtocol = unknown;
export type DriverIdentity = unknown;
export type ModelRole = unknown;
export type ModelBinding = unknown;
export type ResolvedModelBinding = unknown;
export type ModelCapabilities = unknown;
export type ModelRequest = unknown;
export type ModelResponse = unknown;
export type ConversationRequest = unknown;
export type ConversationResult = unknown;
export type CredentialReference = unknown;
export type SelectedCredential = unknown;

/** One native protocol turn, not an SDK-owned agent loop or an implicit failover policy. */
export interface ModelDriver {
  generate(binding: ResolvedModelBinding, request: ModelRequest): Effect.Effect<ModelResponse, Error>;
  capabilities(binding: ResolvedModelBinding): Effect.Effect<ModelCapabilities, Error>;
}
