import { Effect } from 'effect';

/** Privacy projections, collector consent and batch schemas require explicit agreement before implementation. */
export type OperationalEvent = unknown;
export type TelemetryBatch = unknown;
export type TelemetryConsent = unknown;

export class OperationalEvents {
  record(event: OperationalEvent): Effect.Effect<void, Error> {
    // Accept only an allowlisted metadata projection, never raw source, prompts, findings, SDK tracing or credentials.
    return Effect.fail(new Error('Not implemented: OperationalEvents.record'));
  }

  exportTelemetry(batch: TelemetryBatch, consent: TelemetryConsent): Effect.Effect<void, Error> {
    // Export content-free data only with explicit opt-in and the selected offline/network policy; no required collector.
    return Effect.fail(new Error('Not implemented: OperationalEvents.exportTelemetry'));
  }
}
