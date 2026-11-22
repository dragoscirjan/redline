import { Effect } from 'effect';
import type { ReviewDocument } from './types.ts';

/** Persisted identity, provenance, destinations and redaction-handle schemas await the artifact migration specification. */
export type ArtifactReference = unknown;
export type ArtifactReferences = unknown;
export type ArtifactDestination = unknown;
export type ArtifactTrust = unknown;
export type RedactionContext = unknown;

export class ReviewWriter {
  write(document: ReviewDocument, destination: ArtifactDestination, redaction: RedactionContext): Effect.Effect<ArtifactReferences, Error> {
    // Validate, redact all selected credentials, serialize and persist bounded authoritative JSON before any projection is published.
    return Effect.fail(new Error('Not implemented: ReviewWriter.write'));
  }

  read(reference: ArtifactReference, trust: ArtifactTrust): Effect.Effect<ReviewDocument, Error> {
    // Validate schema, trusted origin and revision; parseable PR-supplied JSON is not authorization for replay.
    return Effect.fail(new Error('Not implemented: ReviewWriter.read'));
  }
}
