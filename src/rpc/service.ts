import { Effect, type Scope } from 'effect';
import type { ReviewApplication } from '../application/review.ts';
import type { ReviewConfiguration } from '../application/configuration.ts';

/** Internal handler payloads remain deferred to the existing protocol-1.0 schema migration, not a new wire format. */
export type RpcInitialization = unknown;
export type RpcCapabilities = unknown;
export type RpcReviewRequest = unknown;
export type RpcRunHandle = unknown;
export type RpcResultQuery = unknown;
export type RpcResultPage = unknown;
export type RpcCancelRequest = unknown;
export type RpcCancellation = unknown;
export interface RpcExecutionContext {
  readonly application: ReviewApplication['Service'];
  readonly startup: ReviewConfiguration;
}

export class ReviewRpcService {
  initialize(request: RpcInitialization): Effect.Effect<RpcCapabilities, Error> {
    // Preserve JSON-RPC 2.0, protocol 1.0 negotiation and Content-Length stdio framing; no HTTP listener or LSP replacement.
    return Effect.fail(new Error('Not implemented: ReviewRpcService.initialize'));
  }

  start(request: RpcReviewRequest, context: RpcExecutionContext): Effect.Effect<RpcRunHandle, Error, Scope.Scope> {
    // Validate bounded workspace selections; credentials, endpoints, executables and configuration paths remain trusted startup input.
    return Effect.fail(new Error('Not implemented: ReviewRpcService.start'));
  }

  query(request: RpcResultQuery): Effect.Effect<RpcResultPage, Error> {
    // Project bounded/paged validated results with artifact fallback, never raw prompts or credential-bearing output.
    return Effect.fail(new Error('Not implemented: ReviewRpcService.query'));
  }

  cancel(request: RpcCancelRequest): Effect.Effect<RpcCancellation, Error> {
    // Cancel only the matching owned run and report its deterministic terminal state.
    return Effect.fail(new Error('Not implemented: ReviewRpcService.cancel'));
  }

  shutdown(): Effect.Effect<void, Error> {
    // Preserve one-shot/persistent EOF, backpressure and owned-resource cleanup semantics from the delivered protocol.
    return Effect.fail(new Error('Not implemented: ReviewRpcService.shutdown'));
  }
}
