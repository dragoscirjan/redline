import type { CapturedRevision, RevisionSource } from './types.ts';

/** Native change/commit/bookmark/workspace selection awaits the Jujutsu contract; it is not a Git target alias. */
export type JujutsuSelection = unknown;

export class JujutsuRevisionSource implements RevisionSource {
  private readonly selection: JujutsuSelection;
  constructor(selection: JujutsuSelection) { this.selection = selection; }

  async capture(signal: AbortSignal): Promise<CapturedRevision> {
    // Resolve native identities to immutable captured commits and detect operation/workspace movement without Git substitution.
    throw new Error('Not implemented: JujutsuRevisionSource.capture');
  }
}
