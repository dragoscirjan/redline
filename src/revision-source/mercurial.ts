import type { CapturedRevision, RevisionSource } from './types.ts';

/** Native changeset/bookmark/parent/working-copy selection remains demand- and specification-gated. */
export type MercurialSelection = unknown;

export class MercurialRevisionSource implements RevisionSource {
  private readonly selection: MercurialSelection;
  constructor(selection: MercurialSelection) { this.selection = selection; }

  async capture(signal: AbortSignal): Promise<CapturedRevision> {
    // Capture native revisions or a consistent bounded working copy, preserving multiple-parent semantics without a Git mirror.
    throw new Error('Not implemented: MercurialRevisionSource.capture');
  }
}
