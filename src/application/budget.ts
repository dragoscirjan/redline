import { Effect } from 'effect';

/** Limits, usage units and persisted accounting fields remain pending the run-budget specification. */
export type RunUsage = unknown;
export type BudgetSnapshot = unknown;

export class RunBudget {
  check(): Effect.Effect<void, Error> {
    // Enforce one shared deadline/call/token budget across warmup, review, recovery and finalization.
    return Effect.fail(new Error('Not implemented: RunBudget.check'));
  }

  record(usage: RunUsage): Effect.Effect<void, Error> {
    // Account for application attempts and SDK/transport retries without multiplying hidden retry policies.
    return Effect.fail(new Error('Not implemented: RunBudget.record'));
  }

  snapshot(): Effect.Effect<BudgetSnapshot, Error> {
    // Report remaining bounds and preserve unknown token/cost values as unknown.
    return Effect.fail(new Error('Not implemented: RunBudget.snapshot'));
  }
}
